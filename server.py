#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 EasonShu
"""Kay-cftunnle 服务端 —— 只依赖 Python 标准库的 Cloudflare Tunnel 管理面板。

把「API Token 托管 + 隧道管理 + Ingress 映射 + DNS 维护 + cloudflared 连接器
生命周期」收进一个 HTTP 服务，供浏览器操作。部署到飞牛 NAS 只需 Docker。

运行模型（单进程，M1 单线程 HTTP，M4 起加入连接器监管线程）：
  HTTP 服务    ThreadingHTTPServer，请求处理见 PanelHandler

磁盘布局（路径均相对本文件所在目录）：
  data/workbench.json     全局配置：管理员、加密密钥、Cloudflare 凭据
  data/kay-cftunnle.sqlite3      用户表 / 会话表 / 操作日志（隧道与 DNS 以 Cloudflare 侧为准）
  runtime/                cloudflared 进程 pid、连接器日志（M4 起使用）

入口：
  python server.py [--host H] [--port P]   启动服务
  python server.py --check                 只打印一次状态 JSON 后退出

环境变量：
  KAY_CFTUNNLE_ROOT  工作台根目录，默认取 server.py 所在目录
  DASHBOARD_HOST  监听地址，默认 0.0.0.0
  DASHBOARD_PORT  监听端口，默认 8567
  DASHBOARD_TZ    日期时区，默认 Asia/Shanghai
"""

import argparse
import hashlib
import hmac
import ipaddress
import json
import mimetypes
import os
import re
import secrets
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler

try:  # pragma: no cover - 新版本直接命中
    from http.server import ThreadingHTTPServer
except ImportError:  # pragma: no cover - Python 3.6 兜底
    from http.server import HTTPServer
    from socketserver import ThreadingMixIn

    class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):  # type: ignore
        daemon_threads = True
        allow_reuse_address = True

from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, unquote, urlparse

from cf import CloudflareClient, CloudflareError

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
PROJECT_ROOT = Path(os.environ.get("KAY_CFTUNNLE_ROOT") or APP_DIR).resolve()
DATA_DIR = APP_DIR / "data"
RUNTIME_DIR = APP_DIR / "runtime"
CONFIG_PATH = DATA_DIR / "workbench.json"
DB_PATH = DATA_DIR / "kay-cftunnle.sqlite3"
SESSION_COOKIE = "kay_cftunnle_session"

APP_VERSION = "1.5.0"
# 静态资源版本号：改前端后递增，用于破浏览器缓存（需与 index.html 的 ?v= 保持一致）
STATIC_REV = 41
START_TIME = time.time()
SESSION_MAX_AGE = 7 * 24 * 60 * 60
# 连接器运行超过该秒数视为「稳定运行」，看门狗重试计数归零
STABLE_RUN_SECONDS = 300
PASSWORD_ITERATIONS = 260_000
USERNAME_RE = None  # 单管理员模式，不做注册，M1 不校验用户名格式

# 默认管理员账号（首次启动播种到数据库；no_auth_run=true 时登录页不出现）
DEFAULT_USERNAME = "admin"
DEFAULT_PASSWORD = "123456"
# 历史出厂密码，仅用于升级时识别「用户从未改过密码」
LEGACY_DEFAULT_PASSWORD = "admin123456"

# cloudflared 支持的回源协议；面板按原文下发给 Cloudflare，不做端口推断
SERVICE_SCHEMES = (
    "http://", "https://", "tcp://", "tls://", "ssh://", "rdp://", "smb://",
    "smtp://", "mysql://", "postgresql://", "clickhouse://", "kafka://",
    "unix://", "unix:", "udp://",
)


def _service_ok(service: str) -> bool:
    return str(service or "").startswith(SERVICE_SCHEMES)


def _rule_hostname(subdomain: str, zone_name: str) -> str:
    """规则子域名 → 隧道 Ingress 的 hostname。@ 为根域，* 为泛域名。"""
    sub = str(subdomain or "").strip().lower()
    zone = str(zone_name or "").strip().lower()
    if not zone:
        return ""
    if sub in ("", "@"):
        return zone
    if sub == "*":
        return "*." + zone
    return sub + "." + zone

DEFAULT_CONFIG: Dict[str, Any] = {
    "auth": {
        "username": DEFAULT_USERNAME,
        "password": DEFAULT_PASSWORD,
        "secret": "",
    },
    # Cloudflare 凭据（M2 起由「设置」页写入并做连通性验证）
    "cloudflare": {
        "api_token": "",
        "account_id": "",
        "primary_zone": "",  # M3：当前目标 Zone（zone_id），用于 Ingress / DNS 操作
    },
    # 连接器设置（M4 cloudflared 启动时读取，可提前在设置页保存）
    "connector": {
        "auto_connect": False,
        "protocol": "http2",
        "ip_version": "ipv4",
        "default_tunnel_id": "",
        # 看门狗：进程意外退出后自动拉起（带指数退避）
        "watchdog": True,
        "watchdog_max_retry": 5,
    },
    "panel": {
        "title": "Kay-cftunnle 面板",
        # 免密模式：打开面板即进入管理员视图。
        # 面板持有 Cloudflare Token 权限，切勿在公网裸奔；可用设置页开关关掉。
        "no_auth_run": True,
        "auth_mode_migrated": True,
    },
}


# ------------------------------------------------------------------ 配置装载

def load_config() -> Dict[str, Any]:
    """读取 data/workbench.json；缺省时用 DEFAULT_CONFIG 播种并落盘。"""
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))  # 深拷贝
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
                stored = json.load(fh)
            for key, val in stored.items():
                if isinstance(val, dict) and isinstance(cfg.get(key), dict):
                    cfg[key].update(val)
                else:
                    cfg[key] = val
            # M3 兼容：旧版用 default_zone 存目标域名，迁移到 primary_zone
            old_cf = stored.get("cloudflare", {})
            if old_cf.get("default_zone") and not cfg["cloudflare"].get("primary_zone"):
                cfg["cloudflare"]["primary_zone"] = old_cf["default_zone"].strip()
            # 默认密码迁移：旧版出厂值是 admin123456，新版改为 123456。
            # 仅当配置里仍是「旧的出厂值」时才改，用户自定义过的密码一律不动。
            old_auth = stored.get("auth", {}) or {}
            if old_auth.get("password") == LEGACY_DEFAULT_PASSWORD:
                cfg["auth"]["password"] = DEFAULT_PASSWORD
        except Exception as exc:  # pragma: no cover - 损坏时兜底
            print(f"[!] workbench.json 解析失败（{exc}），使用默认配置", file=sys.stderr)
    panel_cfg = cfg.setdefault("panel", {})
    # 旧配置一次性迁移到免密模式；迁移标记落盘后，用户在设置页关掉免密不会被再次覆盖
    if not panel_cfg.get("auth_mode_migrated"):
        panel_cfg["no_auth_run"] = True
        panel_cfg["auth_mode_migrated"] = True
    if not cfg["auth"].get("secret"):
        cfg["auth"]["secret"] = secrets.token_hex(32)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)
    return cfg


def save_config(cfg: Dict[str, Any]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = CONFIG_PATH.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)


# ------------------------------------------------------------------ 操作审计日志

def add_log(action: str, detail: str = "", level: str = "info") -> None:
    """记录一条面板操作日志（设置变更 / 验证 / 隧道增删等）。"""
    try:
        with db_connect() as conn:
            conn.execute(
                "INSERT INTO logs(ts, level, action, detail) VALUES(?,?,?,?)",
                (int(time.time()), level, str(action)[:64], str(detail)[:500]),
            )
    except Exception as exc:  # pragma: no cover - 日志失败不阻断主流程
        print(f"[!] 写日志失败: {exc}", file=sys.stderr)


def recent_logs(limit: int = 20) -> List[Dict[str, Any]]:
    """最近的操作日志（新的在前）。"""
    with db_connect() as conn:
        rows = conn.execute(
            "SELECT ts, level, action, detail FROM logs ORDER BY id DESC LIMIT ?",
            (max(1, min(int(limit), 200)),),
        ).fetchall()
    return [
        {
            "time": datetime.fromtimestamp(r["ts"]).strftime("%m-%d %H:%M"),
            "level": r["level"],
            "action": r["action"],
            "detail": r["detail"],
        }
        for r in rows
    ]


def add_connector_event(kind: str, detail: str = "") -> None:
    """记录连接器生命周期事件，供「稳定性时间线」展示。"""
    try:
        now = int(time.time())
        with db_connect() as conn:
            conn.execute(
                "INSERT INTO connector_events(ts, kind, detail) VALUES(?,?,?)",
                (now, str(kind)[:24], str(detail)[:300]),
            )
            conn.execute("DELETE FROM connector_events WHERE ts<?", (now - 7 * 24 * 3600,))
    except Exception as exc:  # pragma: no cover - 事件记录失败不阻断连接器
        print(f"[!] 写连接器事件失败: {exc}", file=sys.stderr)


def connector_events(hours: int = 24, limit: int = 40) -> Dict[str, Any]:
    """返回时间窗口内的连接器事件（新的在前）与分类计数。"""
    hours = max(1, min(int(hours), 168))
    limit = max(1, min(int(limit), 200))
    since = int(time.time()) - hours * 3600
    with db_connect() as conn:
        rows = conn.execute(
            "SELECT ts, kind, detail FROM connector_events WHERE ts>=? ORDER BY id DESC LIMIT ?",
            (since, limit),
        ).fetchall()
        counts = {r["kind"]: r["count"] for r in conn.execute(
            "SELECT kind, COUNT(*) AS count FROM connector_events WHERE ts>=? GROUP BY kind",
            (since,),
        ).fetchall()}
    return {
        "events": [
            {
                "time": datetime.fromtimestamp(r["ts"]).strftime("%m-%d %H:%M:%S"),
                "ts": r["ts"],
                "kind": r["kind"],
                "detail": r["detail"],
            }
            for r in rows
        ],
        "counts": counts,
        "hours": hours,
    }


def mask_token(token: str) -> str:
    """Token 脱敏显示：前 6 后 4。"""
    token = token or ""
    if len(token) <= 12:
        return "***" if token else ""
    return token[:6] + "…" + token[-4:]


# 配置写锁：HTTP 多线程下保护 workbench.json 读写
_CFG_LOCK = threading.Lock()


def update_cloudflare_settings(cfg: Dict[str, Any], api_token: str = "",
                               account_id: Optional[str] = None,
                               primary_zone: Optional[str] = None) -> None:
    """更新 Cloudflare 凭据段；api_token 传空串表示保持不变，其余传 None 表示不动。"""
    with _CFG_LOCK:
        cf = cfg["cloudflare"]
        if api_token:
            cf["api_token"] = api_token.strip()
        if account_id is not None:
            cf["account_id"] = account_id.strip()
        if primary_zone is not None:
            cf["primary_zone"] = primary_zone.strip()
        save_config(cfg)


# ------------------------------------------------------------------ 本地服务地址

def _normalize_service(raw: Any) -> str:
    """把「端口号」补成本机 HTTP 地址；填了完整地址的原样放行，交给 _service_ok 校验。"""
    s = str(raw or "").strip()
    if re.fullmatch(r"[1-9][0-9]{0,4}", s):
        return "http://127.0.0.1:" + s
    if re.fullmatch(r"[A-Za-z0-9._-]+:[0-9]{1,5}", s):
        return "http://" + s
    return s


# 回源探测只允许访问本机回环，避免面板变成内网端口扫描器
_PROBE_DEFAULT_PORTS = {
    "http": 80, "https": 443, "tls": 443, "ssh": 22, "rdp": 3389, "smb": 445,
    "smtp": 25, "mysql": 3306, "postgresql": 5432, "clickhouse": 8123, "kafka": 9092,
}


def _probe_error_text(exc: OSError) -> str:
    if isinstance(exc, ConnectionRefusedError):
        return "连接被拒绝，服务可能没有启动"
    if isinstance(exc, socket.gaierror):
        return "无法解析主机名"
    return str(exc) or exc.__class__.__name__


def _probe_unix_socket(path: str) -> Dict[str, Any]:
    if not path:
        return {"reachable": False, "error": "unix 地址缺少 socket 路径"}
    if not os.path.exists(path):
        return {"reachable": False, "error": "socket 文件不存在"}
    if not hasattr(socket, "AF_UNIX"):
        return {"reachable": None, "skipped": True, "error": "当前系统不支持 unix socket 检测"}
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(1.5)
    started = time.perf_counter()
    try:
        sock.connect(path)
    except (socket.timeout, TimeoutError):
        return {"reachable": False, "error": "连接超时（1.5 秒）"}
    except OSError as exc:
        return {"reachable": False, "error": _probe_error_text(exc)}
    finally:
        sock.close()
    return {"reachable": True,
            "latency_ms": int(round((time.perf_counter() - started) * 1000))}


def _probe_service(raw: Any) -> Dict[str, Any]:
    """探测一个回源地址，返回统一结构；只允许回环 TCP 与 unix socket。

    ok=False 表示参数本身不合法；ok=True + reachable=False 表示连不上；
    reachable=None 表示协议无法/不允许检测。调用方无需再区分 HTTP 状态。
    """
    service = _normalize_service(raw)
    if not service:
        return {"ok": False, "error": "本地服务地址不能为空"}
    if not _service_ok(service):
        return {"ok": False, "error": "本地服务地址协议不受支持（http/https/tcp/tls/ssh/rdp/unix 等）"}
    parsed = urlparse(service)
    scheme = (parsed.scheme or "").lower()
    if scheme == "udp":
        return {"ok": True, "reachable": None, "skipped": True, "service": service,
                "target": service, "error": "UDP 是无连接协议，无法用 TCP 探测"}
    if scheme == "unix":
        path = service[len("unix:"):]
        if path.startswith("//"):
            path = path[2:]
        result = _probe_unix_socket(path)
        result.update({"ok": True, "service": service, "target": path})
        return result
    host = parsed.hostname or ""
    try:
        port = parsed.port
    except ValueError:
        port = None
    if port is None:
        port = _PROBE_DEFAULT_PORTS.get(scheme)
    if not host or not port or not 1 <= port <= 65535:
        return {"ok": False, "error": "无法解析主机与端口，请写成 http://127.0.0.1:8080 这样的完整地址"}
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host.lower() == "localhost"
    target = ("[%s]:%d" % (host, port)) if ":" in host else ("%s:%d" % (host, port))
    if not loopback:
        return {"ok": True, "reachable": None, "skipped": True, "service": service,
                "target": target, "error": "只检测本机回环地址（127.0.0.1 / localhost / ::1）"}
    started = time.perf_counter()
    try:
        with socket.create_connection((host, port), timeout=1.5):
            pass
    except (socket.timeout, TimeoutError):
        return {"ok": True, "reachable": False, "service": service, "target": target,
                "error": "连接超时（1.5 秒）"}
    except OSError as exc:
        return {"ok": True, "reachable": False, "service": service, "target": target,
                "error": _probe_error_text(exc)}
    return {"ok": True, "reachable": True, "service": service, "target": target,
            "latency_ms": int(round((time.perf_counter() - started) * 1000))}


# ------------------------------------------------------------------ 连接器（M4 cloudflared 进程监管）

class ConnectorManager:
    """监管 cloudflared 子进程生命周期。

    cloudflared 以 `tunnel run --token <TOKEN>` 方式运行，不依赖本地配置文件；
    日志写入 runtime/connector.log，PID 写入 runtime/connector.pid。
    """

    def __init__(self, cfg: Dict[str, Any]):
        self.cfg = cfg
        self.proc: Optional[subprocess.Popen] = None
        self.started_at: float = 0.0
        self._proc_started_at: float = 0.0  # 本次进程拉起时间，用于判定「刚启动就挂」
        self.current_tunnel_id: str = ""
        self._log_fh: Optional[Any] = None  # cloudflared 日志句柄，停止时关闭
        self.lock = threading.Lock()
        self.log_path = RUNTIME_DIR / "connector.log"
        self.pid_path = RUNTIME_DIR / "connector.pid"
        self._ensure_runtime_dir()
        # ---- 看门狗状态 ----
        self._stop_by_user = False    # 用户主动停止，看门狗不要拉起
        self._retry_count = 0         # 连续自动重试次数
        self._exit_info: Dict[str, Any] = {}  # 最近一次意外退出记录
        self._last_restart_at: float = 0.0
        self._watchdog_thread: Optional[threading.Thread] = None
        self._watchdog_interval = 5.0  # 秒
        self._watchdog_stop = threading.Event()

    def _ensure_runtime_dir(self) -> None:
        RUNTIME_DIR.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def find_binary() -> Optional[str]:
        """按常见路径查找 cloudflared 可执行文件。"""
        candidates = ["cloudflared"]
        if sys.platform == "win32":
            candidates.append("cloudflared.exe")
        paths = [
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/opt/homebrew/bin",
            os.path.expanduser("~/.local/bin"),
        ]
        for name in candidates:
            # PATH 中查找
            path_env = os.environ.get("PATH", "")
            for p in path_env.split(os.pathsep) + paths:
                full = os.path.join(p, name)
                if os.path.isfile(full) and os.access(full, os.X_OK):
                    return full
            # 当前目录
            local = str(APP_DIR / name)
            if os.path.isfile(local) and os.access(local, os.X_OK):
                return local
        return None

    def _write_pid(self, pid: int) -> None:
        try:
            self.pid_path.write_text(str(pid), encoding="utf-8")
        except Exception as exc:  # pragma: no cover
            print(f"[!] 写入 PID 文件失败: {exc}", file=sys.stderr)

    def _clear_pid(self) -> None:
        try:
            if self.pid_path.exists():
                self.pid_path.unlink()
        except Exception:
            pass

    def _read_pid(self) -> int:
        try:
            return int(self.pid_path.read_text(encoding="utf-8").strip())
        except Exception:
            return 0

    def _read_logs(self, tail: int = 50, start: int = 0) -> List[str]:
        try:
            if not self.log_path.exists():
                return []
            with open(self.log_path, "r", encoding="utf-8", errors="replace") as fh:
                lines = fh.readlines()
            if start:
                lines = lines[start:]
            else:
                lines = lines[-tail:]
            return [line.rstrip("\n") for line in lines]
        except Exception:
            return []

    def _log_line_count(self) -> int:
        """当前日志行数，用作「本次启动输出」的起点标记。"""
        try:
            if not self.log_path.exists():
                return 0
            with open(self.log_path, "r", encoding="utf-8", errors="replace") as fh:
                return len(fh.readlines())
        except Exception:
            return 0

    def _resolve_tunnel(self, tunnel_id: str = "") -> Tuple[Optional[str], Optional[str]]:
        """确定要启动的隧道：参数 > 配置默认 > 第一个可用隧道。"""
        if not tunnel_id:
            tunnel_id = (self.cfg.get("connector") or {}).get("default_tunnel_id", "")
        cf = self.cfg.get("cloudflare") or {}
        if not cf.get("api_token"):
            return None, "尚未配置 Cloudflare 凭据"
        client = CloudflareClient(cf["api_token"], cf.get("account_id") or "")
        try:
            tunnels = client.list_tunnels()
        except CloudflareError as exc:
            return None, "获取隧道列表失败：" + str(exc)
        if not tunnels:
            return None, "账号下没有可用隧道，请先创建隧道"
        # 若指定了 tunnel_id，优先匹配
        if tunnel_id:
            for t in tunnels:
                if t["id"] == tunnel_id:
                    return t["id"], None
        # 否则取第一个
        return tunnels[0]["id"], None

    def start(self, tunnel_id: str = "", auto: bool = False) -> Dict[str, Any]:
        """启动 cloudflared。auto=True 表示由看门狗/自动连接拉起，非用户手动。"""
        with self.lock:
            if self.proc and self.proc.poll() is None:
                return {"ok": False, "error": "连接器已在运行中"}
            self._stop_by_user = False

            binary = self.find_binary()
            if not binary:
                return {"ok": False, "error": "未找到 cloudflared 可执行文件，请先安装或放到 PATH 中"}

            resolved, err = self._resolve_tunnel(tunnel_id)
            if not resolved:
                return {"ok": False, "error": err or "无法确定启动隧道"}

            cf = self.cfg.get("cloudflare") or {}
            api_token = str(cf.get("api_token") or "").strip()
            if not api_token:
                return {"ok": False, "error": "尚未配置 Cloudflare API Token，请先到「设置」页填写"}
            client = CloudflareClient(api_token, cf.get("account_id") or "")
            try:
                token = client.get_tunnel_token(resolved)
            except CloudflareError as exc:
                return {"ok": False, "error": "获取隧道令牌失败：" + str(exc)}

            # 令牌必须是 cloudflared 认的 base64(JSON) 串（eyJ...）。
            # 之前没校验：令牌为空时 cloudflared 会把 "--token ''" 当「没指定隧道」，
            # 打印 tunnel run 的用法说明后以退出码 0 结束，表现为「启动中→瞬间停止」死循环，
            # 界面上完全看不出原因。这里提前拦住并给出可执行的提示。
            token = str(token or "").strip()
            if not token:
                return {"ok": False, "error": "Cloudflare 未返回隧道令牌（为空）。"
                                              "请确认 API Token 具备 Cloudflare Tunnel 的编辑权限，"
                                              "并检查隧道 %s 是否已被删除" % resolved[:8]}
            if not token.startswith("eyJ"):
                return {"ok": False, "error": "隧道令牌格式异常（应以 eyJ 开头，实际以 %r 开头），"
                                              "疑似 API 返回的不是令牌本身" % token[:12]}

            conn_cfg = self.cfg.get("connector", {})
            # 只有用户「显式配置过」才追加协议参数。
            # 默认走官方最小写法 cloudflared tunnel --no-autoupdate run --token <T>，
            # 这条命令所有 cloudflared 版本都认，跟开源 compose 里写的一模一样。
            raw_protocol = str(conn_cfg.get("protocol", "") or "").strip().lower()
            protocol = raw_protocol if raw_protocol in ("quic", "http2") else "http2"
            raw_ip = str(conn_cfg.get("ip_version", "") or "").strip().lower()
            ip_version = raw_ip if raw_ip in ("ipv4", "ipv6", "auto") else "ipv4"
            # auto 交给 cloudflared 自己判断，不要再被当成 IPv6
            edge_ip = {"ipv4": "4", "ipv6": "6"}.get(ip_version, "auto")

            opt_flags = []
            if raw_protocol in ("quic", "http2"):
                opt_flags += ["--protocol", protocol]
            if raw_ip in ("ipv4", "ipv6", "auto"):
                opt_flags += ["--edge-ip-version", edge_ip]

            self._ensure_runtime_dir()
            # 清空旧日志或追加？选择追加更利于排查，但启动时截尾保留最近 500 行
            self._rotate_log()
            log_fh = open(self.log_path, "a", encoding="utf-8", errors="replace")

            kwargs: Dict[str, Any] = {
                "stdout": log_fh,
                "stderr": subprocess.STDOUT,
                "close_fds": True,
            }
            if sys.platform == "win32":
                kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
                kwargs["startupinfo"] = subprocess.STARTUPINFO()  # type: ignore[attr-defined]
                kwargs["startupinfo"].dwFlags |= subprocess.STARTF_USESHOWWINDOW  # type: ignore[attr-defined]

            # 候选命令：
            #   1) 按配置带上协议参数（全局参数必须在子命令 run 之前，否则被判未知参数）
            #   2) 官方最小写法，兜底所有版本差异
            # 第 1 条秒退且原因是参数类错误时，自动降级到第 2 条再试一次。
            candidates = []
            if opt_flags:
                candidates.append([binary, "tunnel", "--no-autoupdate"]
                                  + opt_flags + ["run", "--token", token])
            candidates.append([binary, "tunnel", "--no-autoupdate", "run", "--token", token])

            last_error = ""
            for attempt, cmd in enumerate(candidates):
                if attempt > 0:
                    log_fh.write("\n--- 上一个启动参数被拒绝，改用官方最小写法重试 ---\n")
                    log_fh.flush()
                    add_log("connector", "启动参数不被接受，自动降级为最小写法重试")
                add_log("connector", "执行：" + self._mask_cmd(cmd))
                # 记录本次启动前的日志行数，判定退出原因时只看这之后的新输出
                self._log_offset = self._log_line_count()

                try:
                    self.proc = subprocess.Popen(cmd, **kwargs)
                    self._log_fh = log_fh
                except Exception as exc:
                    last_error = "启动 cloudflared 失败：" + str(exc)
                    log_fh.write(last_error + "\n")
                    log_fh.flush()
                    self.proc = None
                    continue

                self.started_at = time.time()
                self._proc_started_at = self.started_at
                self.current_tunnel_id = resolved

                # 启动后短暂观察：cloudflared 参数不被接受、令牌无效时会在 1 秒内退出。
                # 以前直接返回 ok=True，界面停在「启动中…」，只有等看门狗下一轮才发现已经死了，
                # 用户看到的只是「秒退 + 无限重试」，完全不知道原因。这里立刻把真实原因返回。
                early = self._wait_early_exit(1.5)
                if not early:
                    break  # 起来了，跳出重试循环

                rc, reason, fatal = early
                last_error = "cloudflared 启动后立即退出（退出码 %s）：%s" % (rc, reason)
                add_log("connector", last_error, "error")
                self._exit_info = {
                    "exit_code": rc,
                    "exit_at": int(time.time()),
                    "uptime": 0,
                    "tunnel_id": resolved,
                    "reason": reason,
                }
                add_connector_event("exit", "启动后立即退出（退出码 %s）：%s" % (rc, reason))

                if not fatal:
                    # 网络类问题：保留 proc 交给看门狗按退避继续重试
                    return {"ok": False, "error": last_error}

                # 参数/令牌类错误：这一轮参数组合被拒绝，还有备选就换一套再试
                self.proc = None
                self._clear_pid()
                self.current_tunnel_id = ""
                if attempt + 1 < len(candidates):
                    continue
                # 已经是最后一套参数：重试多少次结果都一样，直接放弃并保留原因，
                # 避免看门狗 5 次无意义重试把日志刷满、还让界面一直"重试中"
                self._close_log_fh()
                self._exit_info["give_up"] = True
                add_connector_event("give_up", "启动参数或令牌不可用，已停止重试：" + reason)
                return {"ok": False, "error": last_error}

            if self.proc is None:
                # 全部候选都失败
                self._close_log_fh()
                if self._exit_info:
                    self._exit_info["give_up"] = True
                add_connector_event("give_up", last_error or "cloudflared 启动失败")
                return {"ok": False, "error": last_error or "cloudflared 启动失败"}

            if not auto:
                self._retry_count = 0
                self._exit_info = {}
            else:
                # 自动拉起成功：清掉上次的退出记录与「已放弃」标记，
                # 否则界面会一直显示 give_up=True，与实际情况矛盾
                self._exit_info.pop("give_up", None)
            self._write_pid(self.proc.pid)
            ip_label = {"4": "IPv4", "6": "IPv6"}.get(edge_ip, "IPv4/IPv6 自动")
            add_log("connector", "启动隧道 %s（%s / %s）%s"
                    % (resolved[:8], protocol, ip_label, "· 自动重试第 %d 次" % self._retry_count if auto and self._retry_count else ""))
            add_connector_event("start", "隧道 %s · %s / %s%s"
                    % (resolved[:8], protocol, ip_label,
                       " · 自动拉起第 %d 次" % self._retry_count if auto and self._retry_count else
                       (" · 自动拉起" if auto else "")))

            return {
                "ok": True,
                "pid": self.proc.pid,
                "tunnel_id": resolved,
                "protocol": protocol,
                "ip_version": ip_version,
            }

    @staticmethod
    def _mask_cmd(cmd) -> str:
        """把命令行拼成可读字符串，隐藏令牌正文，避免日志泄漏。"""
        out = []
        hide_next = False
        for part in cmd:
            if hide_next:
                out.append("<TOKEN:%d 字符>" % len(str(part)))
                hide_next = False
                continue
            out.append(str(part))
            if str(part) == "--token":
                hide_next = True
        return " ".join(out)

    def _wait_early_exit(self, seconds: float):
        """观察 seconds 秒；若进程提前退出，返回 (退出码, 原因, 是否致命)，否则返回 None。"""
        deadline = time.time() + seconds
        while time.time() < deadline:
            if self.proc is None or self.proc.poll() is not None:
                break
            time.sleep(0.1)
        if self.proc is None:
            return None
        rc = self.proc.poll()
        if rc is None:
            return None
        reason, fatal = self._exit_reason()
        return rc, reason, fatal

    def _exit_reason(self) -> Tuple[str, bool]:
        """返回 (可读原因, 是否属于「重试也没用」的配置性错误)。"""
        try:
            # 只看「本次启动」之后新写入的输出，避免上一轮/上一天的日志误导判断
            lines = self._read_logs(start=int(getattr(self, "_log_offset", 0) or 0))
        except Exception:
            lines = []
        joined = "\n".join(lines).lower()
        if "flag provided but not defined" in joined:
            return ("cloudflared 不认识某个启动参数（flag provided but not defined），"
                    "参数顺序或版本不匹配", True)
        if "incorrect usage" in joined or "usage:" in joined:
            return ("cloudflared 打印了用法说明就退出，说明它没拿到有效令牌"
                    "（--token 为空或隧道未指定），不是网络问题", True)
        if "failed to parse token" in joined or "invalid tunnel token" in joined:
            return "隧道令牌无法解析，请到 Cloudflare 重新复制该隧道的令牌", True
        if "unauthorized" in joined or " 401" in joined:
            return "令牌被拒绝（401），隧道可能已删除或令牌已轮换", True
        if "context deadline exceeded" in joined or "failed to connect to edge" in joined:
            return ("连不上 Cloudflare 边缘节点；若协议是 QUIC（UDP 7844），"
                    "很多家宽会封 UDP，把协议改成 http2 再试", False)
        return (self._tail_reason() or "无日志输出"), False

    def _rotate_log(self, keep: int = 500) -> None:
        """启动前保留日志尾部，防止文件无限增长。"""
        try:
            if not self.log_path.exists():
                return
            with open(self.log_path, "r", encoding="utf-8", errors="replace") as fh:
                lines = fh.readlines()
            if len(lines) > keep:
                with open(self.log_path, "w", encoding="utf-8", errors="replace") as fh:
                    fh.writelines(lines[-keep:])
        except Exception:
            pass

    def stop(self, by_user: bool = True) -> Dict[str, Any]:
        """停止 cloudflared。by_user=False 表示内部调用（如重启），看门狗仍可接管。"""
        with self.lock:
            if by_user:
                self._stop_by_user = True
                self._retry_count = 0
                self._exit_info = {}
            if not self.proc or self.proc.poll() is not None:
                # 尝试清理遗留 PID
                pid = self._read_pid()
                killed = False
                if pid:
                    killed = self._kill_pid(pid)
                self._close_log_fh()
                self._clear_pid()
                return {"ok": True, "was_running": False, "killed_external": killed}

            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                try:
                    self.proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    pass
            self._close_log_fh()
            self._clear_pid()
            self.current_tunnel_id = ""
            add_log("connector", "停止连接器（PID %s）" % self.proc.pid)
            add_connector_event("stop", "手动停止（PID %s）" % self.proc.pid)
            return {"ok": True, "was_running": True}

    def _close_log_fh(self) -> None:
        """关闭 cloudflared 日志句柄（幂等）。"""
        fh = getattr(self, "_log_fh", None)
        if fh is not None:
            try:
                fh.close()
            except Exception:
                pass
            self._log_fh = None

    def restart(self, tunnel_id: str = "") -> Dict[str, Any]:
        add_connector_event("restart", "手动重启" + (" · 隧道 " + tunnel_id[:8] if tunnel_id else ""))
        self.stop(by_user=False)
        return self.start(tunnel_id)

    def clear_logs(self) -> Dict[str, Any]:
        """清空连接器日志文件。"""
        try:
            self._ensure_runtime_dir()
            if self.log_path.exists():
                self.log_path.write_text("", encoding="utf-8")
            return {"ok": True}
        except Exception as exc:
            return {"ok": False, "error": "清空日志失败：" + str(exc)}

    # ---- 看门狗 ----

    def start_watchdog(self) -> None:
        """启动看门狗线程（幂等）。"""
        if self._watchdog_thread and self._watchdog_thread.is_alive():
            return
        self._watchdog_stop.clear()
        self._watchdog_thread = threading.Thread(
            target=self._watchdog_loop, name="connector-watchdog", daemon=True
        )
        self._watchdog_thread.start()

    def stop_watchdog(self) -> None:
        self._watchdog_stop.set()

    def _watchdog_loop(self) -> None:
        """周期性检查 cloudflared 是否意外退出；退出则按指数退避自动拉起。"""
        while not self._watchdog_stop.wait(self._watchdog_interval):
            try:
                self._watchdog_tick()
            except Exception as exc:  # pragma: no cover - 看门狗自身不能崩
                print("[!] 看门狗异常: %s" % exc, file=sys.stderr)

    def _watchdog_tick(self) -> None:
        conn_cfg = self.cfg.get("connector", {}) or {}
        if not conn_cfg.get("watchdog", True):
            return

        with self.lock:
            if self._stop_by_user:
                return
            proc = self.proc
            if proc is None:
                return
            rc = proc.poll()
            if rc is None:
                return  # 还在跑
            # ---- 进程已退出，判定为意外退出 ----
            uptime = int(time.time() - self._proc_started_at) if self._proc_started_at else 0
            self._exit_info = {
                "exit_code": rc,
                "exit_at": int(time.time()),
                "uptime": uptime,
                "tunnel_id": self.current_tunnel_id,
            }
            self.proc = None
            self.started_at = 0.0
            self._clear_pid()
            reason, fatal = self._exit_reason()
            self._exit_info["reason"] = reason
            add_log("connector", "进程意外退出（退出码 %s，运行 %ds）：%s"
                    % (rc, uptime, reason or "无日志"), "error")
            add_connector_event("exit", "退出码 %s · 运行 %ds · %s"
                    % (rc, uptime, reason or "无日志输出"))
            max_retry = int(conn_cfg.get("watchdog_max_retry", 5) or 5)
            # 运行足够久才挂，说明隧道本身是健康的，计数归零避免长期累积
            if uptime >= STABLE_RUN_SECONDS:
                self._retry_count = 0
            # 启动即挂 + 原因是令牌/参数这类配置问题：重试多少次都一样，直接放弃
            if fatal and uptime <= 10:
                add_log("connector", "退出原因是配置问题，已停止自动拉起：" + reason, "error")
                self._exit_info["give_up"] = True
                add_connector_event("give_up", "配置问题，停止自动拉起：" + reason)
                return
            if self._retry_count >= max_retry:
                add_log("connector", "自动重试已达上限（%d 次），已停止拉起" % max_retry, "error")
                self._exit_info["give_up"] = True
                add_connector_event("give_up", "自动重试已达上限（%d 次）" % max_retry)
                return
            self._retry_count += 1
            delay = min(60, 2 ** self._retry_count)  # 2,4,8,16,32,60… 秒
            tunnel_id = self.current_tunnel_id
            add_connector_event("retry", "第 %d 次自动拉起，%d 秒后重试"
                                % (self._retry_count, delay))

        # 锁外退避等待（不阻塞 status 查询）
        time.sleep(delay)
        if self._stop_by_user:
            return
        result = self.start(tunnel_id, auto=True)
        if result.get("ok"):
            self._last_restart_at = time.time()
        else:
            add_log("connector", "自动拉起失败：" + str(result.get("error")), "error")
            add_connector_event("start_fail", "自动拉起失败：" + str(result.get("error")))

    def _tail_reason(self) -> str:
        """从日志尾部提取一条最有信息量的错误行。"""
        lines = self._read_logs(30)
        for line in reversed(lines):
            low = line.lower()
            if any(k in low for k in ("error", "failed", "fatal", "panic", "err=")):
                return line.strip()[:200]
        return lines[-1].strip()[:200] if lines else ""

    def reset_watchdog(self) -> None:
        """用户手动启动/停止时重置重试计数（需在锁外调用）。"""
        self._retry_count = 0
        self._exit_info = {}

    def watchdog_info(self) -> Dict[str, Any]:
        conn_cfg = self.cfg.get("connector", {}) or {}
        return {
            "enabled": bool(conn_cfg.get("watchdog", True)),
            "max_retry": int(conn_cfg.get("watchdog_max_retry", 5) or 5),
            "retry_count": self._retry_count,
            "last_restart_at": self._last_restart_at,
            "exit": self._exit_info,
        }

    def get_binary_version(self) -> str:
        """获取 cloudflared 二进制版本号，失败返回空字符串。"""
        binary = self.find_binary()
        if not binary:
            return ""
        try:
            result = subprocess.run(
                [binary, "--version"],
                capture_output=True, text=True, timeout=5, errors="replace"
            )
            output = (result.stdout or result.stderr or "").strip()
            # cloudflared version 2025.1.0 (built 2025-01-XX...)
            m = re.search(r"cloudflared\s+version\s+(\S+)", output, re.I)
            if m:
                return m.group(1)
            # 兜底：返回第一行非空内容
            for line in output.splitlines():
                line = line.strip()
                if line:
                    return line
            return ""
        except Exception:
            return ""

    def _kill_pid(self, pid: int) -> bool:
        """按遗留 PID 强制结束外部进程。"""
        try:
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                               capture_output=True, timeout=5)
            else:
                os.kill(pid, signal.SIGTERM)
                time.sleep(1)
                try:
                    os.kill(pid, 0)
                    os.kill(pid, signal.SIGKILL)
                except OSError:
                    pass
            return True
        except Exception:
            return False

    def status(self) -> Dict[str, Any]:
        """返回当前连接器状态。"""
        with self.lock:
            running = bool(self.proc and self.proc.poll() is None)
            pid = self.proc.pid if running else self._read_pid()
            uptime = 0
            if running and self.started_at:
                uptime = int(time.time() - self.started_at)
            binary = self.find_binary()
            conn_cfg = self.cfg.get("connector", {})
            return {
                "ok": True,
                "running": running,
                "pid": pid,
                "uptime": uptime,
                "binary_exists": bool(binary),
                "binary_path": binary or "",
                "protocol": conn_cfg.get("protocol", "http2"),
                "ip_version": conn_cfg.get("ip_version", "ipv4"),
                "default_tunnel_id": conn_cfg.get("default_tunnel_id", ""),
                "current_tunnel_id": self.current_tunnel_id,
                "auto_connect": conn_cfg.get("auto_connect", False),
                "watchdog": self.watchdog_info(),
                "logs": self._read_logs(200),
            }

    def auto_connect(self) -> None:
        """服务启动时，若配置 auto_connect 则尝试启动。"""
        conn_cfg = self.cfg.get("connector", {})
        if not conn_cfg.get("auto_connect"):
            return
        if not self.find_binary():
            print("[!] auto_connect 已开启，但未找到 cloudflared 二进制", file=sys.stderr)
            return
        result = self.start(auto=True)
        if result.get("ok"):
            print("[*] 自动启动 cloudflared 成功，PID %s" % result.get("pid"), flush=True)
        else:
            print("[!] 自动启动 cloudflared 失败：%s" % result.get("error"), file=sys.stderr)
            add_connector_event("start_fail", "服务启动时自动连接失败：" + str(result.get("error")))


# ------------------------------------------------------------------ 数据库

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS logs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
CREATE TABLE IF NOT EXISTS connector_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_connector_events_ts ON connector_events(ts);
CREATE TABLE IF NOT EXISTS ingress_rules(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subdomain TEXT NOT NULL,
    zone_id TEXT NOT NULL,
    zone_name TEXT NOT NULL,
    tunnel_id TEXT NOT NULL,
    tunnel_name TEXT NOT NULL,
    service TEXT NOT NULL,
    cf_record_id TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(subdomain, zone_id)
);
CREATE INDEX IF NOT EXISTS idx_ingress_zone ON ingress_rules(zone_id);
"""


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def db_init(cfg: Dict[str, Any]) -> None:
    """建表并按 workbench.json 播种管理员（密码变化时同步更新）。"""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with db_connect() as conn:
        conn.executescript(SCHEMA)
        row = conn.execute("SELECT id FROM users WHERE username=?", (cfg["auth"]["username"],)).fetchone()
        salt = secrets.token_hex(16)
        pass_hash = hash_password(cfg["auth"]["password"], salt)
        if row is None:
            conn.execute(
                "INSERT INTO users(id, username, pass_hash, salt, role, created_at) VALUES(?,?,?,?,?,?)",
                (uuid.uuid4().hex, cfg["auth"]["username"], pass_hash, salt, "admin", int(time.time())),
            )
        else:
            cur = conn.execute("SELECT pass_hash, salt FROM users WHERE id=?", (row["id"],)).fetchone()
            if not verify_password(cfg["auth"]["password"], cur["salt"], cur["pass_hash"]):
                conn.execute("UPDATE users SET pass_hash=?, salt=? WHERE id=?", (pass_hash, salt, row["id"]))


def hash_password(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), PASSWORD_ITERATIONS
    ).hex()


def verify_password(password: str, salt: str, expected: str) -> bool:
    return hmac.compare_digest(hash_password(password, salt), expected)


# ------------------------------------------------------------------ 会话

def create_session(user_id: str) -> str:
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    with db_connect() as conn:
        conn.execute(
            "INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES(?,?,?,?)",
            (token, user_id, now, now + SESSION_MAX_AGE),
        )
        conn.execute("DELETE FROM sessions WHERE expires_at<?", (now,))
    return token


def session_user(token: str) -> Optional[sqlite3.Row]:
    if not token:
        return None
    now = int(time.time())
    with db_connect() as conn:
        row = conn.execute(
            "SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id=s.user_id"
            " WHERE s.token=? AND s.expires_at>?",
            (token, now),
        ).fetchone()
    return row


def drop_session(token: str) -> None:
    with db_connect() as conn:
        conn.execute("DELETE FROM sessions WHERE token=?", (token,))


# ------------------------------------------------------------------ 登录限流（内存）

_FAIL_LOCK = threading.Lock()
_FAIL_RECORD: Dict[str, Tuple[int, float]] = {}
FAIL_WINDOW = 300
FAIL_MAX = 8


def login_limited(ip: str) -> bool:
    now = time.time()
    with _FAIL_LOCK:
        cnt, first = _FAIL_RECORD.get(ip, (0, now))
        if now - first > FAIL_WINDOW:
            _FAIL_RECORD[ip] = (0, now)
            return False
        return cnt >= FAIL_MAX


def login_fail(ip: str) -> None:
    now = time.time()
    with _FAIL_LOCK:
        cnt, first = _FAIL_RECORD.get(ip, (0, now))
        if now - first > FAIL_WINDOW:
            cnt, first = 0, now
        _FAIL_RECORD[ip] = (cnt + 1, first)


def login_ok(ip: str) -> None:
    with _FAIL_LOCK:
        _FAIL_RECORD.pop(ip, None)


# ------------------------------------------------------------------ HTTP 处理

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".webmanifest": "application/manifest+json",
}


class PanelHandler(BaseHTTPRequestHandler):
    server_version = "Kay-cftunnle/1.0"
    protocol_version = "HTTP/1.1"
    cfg: Dict[str, Any] = {}
    _head_only = False

    # ------------------------------------------------------------ 基础工具

    def log_message(self, fmt, *args):  # noqa: N802 - 基类签名
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def _send_json(self, payload: Dict[str, Any], status: int = 200,
                   headers: Optional[Dict[str, str]] = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, val in (headers or {}).items():
            self.send_header(key, val)
        self.end_headers()
        if not self._head_only:  # HEAD 请求只发头，发体会导致 keep-alive 连接错位
            self.wfile.write(body)

    def _send_error_json(self, status: int, message: str, log: bool = False) -> None:
        if log:
            add_log("api", "[%d] %s" % (status, message), "warn")
        self._send_json({"ok": False, "error": message}, status)

    def _read_body(self) -> Dict[str, Any]:
        # _dispatch 已经按 Content-Length 读空请求体，避免 keep-alive 连接里
        # 未消费的 "{}" 粘到下一条请求上（表现为 501 Unsupported method）。
        raw = getattr(self, "_raw_body", b"")
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _session_token(self) -> str:
        cookie = self.headers.get("Cookie") or ""
        for part in cookie.split(";"):
            part = part.strip()
            if part.startswith(SESSION_COOKIE + "="):
                return unquote(part[len(SESSION_COOKIE) + 1:])
        return ""

    def _current_user(self) -> Optional[sqlite3.Row]:
        if self.cfg["panel"].get("no_auth_run"):
            with db_connect() as conn:
                return conn.execute(
                    "SELECT id, username, role FROM users WHERE role='admin' ORDER BY created_at LIMIT 1"
                ).fetchone()
        return session_user(self._session_token())

    # ------------------------------------------------------------ 路由入口

    def do_GET(self):  # noqa: N802
        self._dispatch("GET")

    def do_HEAD(self):  # noqa: N802
        self._dispatch("GET", head_only=True)

    def do_POST(self):  # noqa: N802
        self._dispatch("POST")

    def do_DELETE(self):  # noqa: N802
        self._dispatch("DELETE")

    def _dispatch(self, method: str, head_only: bool = False) -> None:
        self._head_only = head_only
        self._raw_body = b""
        if method != "GET":
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if 0 < length <= 1 << 20:
                self._raw_body = self.rfile.read(length)
        path = urlparse(self.path).path
        try:
            if path.startswith("/api/"):
                self._handle_api(method, path)
                return
            self._serve_static(path, head_only)
        except BrokenPipeError:  # pragma: no cover - 客户端提前断开
            pass
        except Exception as exc:  # pragma: no cover - 兜底不崩服务
            print(f"[x] 处理 {self.command} {path} 出错: {exc}", file=sys.stderr)
            try:
                self._send_error_json(500, "internal error")
            except Exception:
                pass

    # ------------------------------------------------------------ API

    def _handle_api(self, method: str, path: str) -> None:
        route = path[len("/api"):] or "/"
        # 归一化：去掉查询串、合并重复斜杠、去掉结尾斜杠
        # 反向代理、浏览器插件、手敲地址都可能带上 ?query= 或末尾 /，
        # 不归一化会被误判成「接口不存在」，从而掩盖真正的业务错误。
        route = route.split("?", 1)[0].split("#", 1)[0]
        while "//" in route:
            route = route.replace("//", "/")
        if len(route) > 1 and route.endswith("/"):
            route = route.rstrip("/") or "/"

        if route == "/health" and method == "GET":
            self._send_json({"ok": True, "service": "kay-cftunnle", "time": int(time.time())})
            return

        if route == "/auth/login" and method == "POST":
            self._api_login()
            return
        if route == "/auth/logout" and method == "POST":
            token = self._session_token()
            if token:
                drop_session(token)
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Set-Cookie", f"{SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if route == "/auth/me" and method == "GET":
            user = self._current_user()
            if user is None:
                self._send_error_json(401, "未登录")
                return
            self._send_json({
                "ok": True,
                "user": {"username": user["username"], "role": user["role"]},
                "no_auth_run": bool(self.cfg["panel"].get("no_auth_run")),
                "cloudflare_configured": bool(self.cfg["cloudflare"].get("api_token")),
            })
            return

        # 其余 API 一律要求登录（M2 起在此挂隧道/DNS/连接器路由）
        if self._current_user() is None:
            self._send_error_json(401, "未登录")
            return
        self._handle_panel_api(method, route)

    def _api_login(self) -> None:
        # 无密码模式：直接返回第一个管理员账号，省去登录步骤
        if self.cfg["panel"].get("no_auth_run"):
            with db_connect() as conn:
                row = conn.execute("SELECT * FROM users WHERE role='admin' ORDER BY created_at LIMIT 1").fetchone()
            if row is None:
                self._send_error_json(500, "未找到管理员账号")
                return
            token = create_session(row["id"])
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header(
                "Set-Cookie",
                f"{SESSION_COOKIE}={token}; Max-Age={SESSION_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax",
            )
            body = json.dumps({"ok": True, "user": {"username": row["username"], "role": row["role"]}},
                              ensure_ascii=False).encode("utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not self._head_only:
                self.wfile.write(body)
            return

        ip = self.client_address[0] if self.client_address else "?"
        if login_limited(ip):
            self._send_error_json(429, "失败次数过多，请 5 分钟后再试")
            return
        body = self._read_body()
        username = str(body.get("username") or "").strip()
        password = str(body.get("password") or "")
        if not username or not password:
            self._send_error_json(400, "用户名和密码不能为空")
            return
        if username != self.cfg["auth"]["username"]:
            login_fail(ip)
            self._send_error_json(401, "用户名或密码错误")
            return
        with db_connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        if row is None or not verify_password(password, row["salt"], row["pass_hash"]):
            login_fail(ip)
            self._send_error_json(401, "用户名或密码错误")
            return
        login_ok(ip)
        token = create_session(row["id"])
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header(
            "Set-Cookie",
            f"{SESSION_COOKIE}={token}; Max-Age={SESSION_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax",
        )
        body = json.dumps({"ok": True, "user": {"username": row["username"], "role": row["role"]}},
                          ensure_ascii=False).encode("utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not self._head_only:
            self.wfile.write(body)

    # ------------------------------------------------------------ 面板 API（M2）

    def _handle_panel_api(self, method: str, route: str) -> None:
        parts = [p for p in route.split("/") if p]

        if route == "/cloudflare/status" and method == "GET":
            self._api_cf_status()
            return
        if route == "/cloudflare/settings" and method == "POST":
            self._api_cf_settings_save()
            return
        if route == "/cloudflare/verify" and method == "POST":
            self._api_cf_verify()
            return
        if route == "/cloudflare/zones" and method == "GET":
            self._api_cf_zones()
            return
        if route == "/cloudflare/zones/primary" and method == "POST":
            self._api_cf_zones_primary_save()
            return
        if route == "/system/settings" and method == "GET":
            self._api_system_settings_get()
            return
        if route == "/system/settings" and method == "POST":
            self._api_system_settings_save()
            return
        if route == "/system/info" and method == "GET":
            self._api_system_info()
            return
        if route == "/system/selfcheck" and method == "GET":
            self._api_system_selfcheck()
            return
        if route == "/system/backup" and method == "GET":
            self._api_backup_export()
            return
        if route == "/system/backup" and method == "POST":
            self._api_backup_import()
            return
        if route == "/tunnels" and method == "GET":
            self._api_tunnels_list()
            return
        if route == "/tunnels" and method == "POST":
            self._api_tunnel_create()
            return
        if len(parts) == 2 and parts[0] == "tunnels" and method == "DELETE":
            self._api_tunnel_delete(parts[1])
            return
        if len(parts) == 3 and parts[0] == "tunnels" and parts[2] == "token" and method == "GET":
            self._api_tunnel_token(parts[1])
            return
        if route == "/ingresses" and method == "GET":
            self._api_ingresses_list()
            return
        if route == "/ingresses" and method == "POST":
            self._api_ingress_create()
            return
        if route == "/ingresses/probe" and method == "POST":
            self._api_ingress_probe()
            return
        if route == "/ingresses/probe-batch" and method == "POST":
            self._api_ingress_probe_batch()
            return
        if route == "/ingresses/sync" and method == "POST":
            self._api_ingress_sync()
            return
        if len(parts) == 2 and parts[0] == "ingresses" and method == "DELETE":
            self._api_ingress_delete(parts[1])
            return
        if len(parts) == 2 and parts[0] == "ingresses" and method == "POST":
            self._api_ingress_update(parts[1])
            return
        if route == "/cloudflare/dns-records" and method == "GET":
            self._api_dns_records_list()
            return
        if route == "/logs" and method == "GET":
            self._api_logs()
            return
        if route == "/auth/password" and method == "POST":
            self._api_change_password()
            return
        if route == "/connector/status" and method == "GET":
            self._api_connector_status()
            return
        if route == "/connector/events" and method == "GET":
            self._api_connector_events()
            return
        if route == "/connector/start" and method == "POST":
            self._api_connector_start()
            return
        if route == "/connector/stop" and method == "POST":
            self._api_connector_stop()
            return
        if route == "/connector/restart" and method == "POST":
            self._api_connector_restart()
            return
        if route == "/connector/clear-logs" and method == "POST":
            self._send_json(CONNECTOR.clear_logs())
            return
        if route == "/connector/default" and method == "POST":
            self._api_connector_default()
            return

        self._send_error_json(
            404,
            "接口不存在: %s（%s）— 请确认容器已更新：docker compose up -d --build --force-recreate"
            % (route, method),
            log=True,
        )

    # ---- Cloudflare 凭据 ----

    def _api_cf_status(self) -> None:
        cf = self.cfg["cloudflare"]
        self._send_json({
            "ok": True,
            "configured": bool(cf.get("api_token")),
            "token_masked": mask_token(cf.get("api_token") or ""),
            "account_id": cf.get("account_id") or "",
            "primary_zone": cf.get("primary_zone") or "",
            "default_zone": cf.get("primary_zone") or "",  # M3 兼容旧前端
        })

    def _api_cf_settings_save(self) -> None:
        body = self._read_body()
        token = str(body.get("api_token") or "").strip()
        account_id = str(body.get("account_id") or "").strip()
        update_cloudflare_settings(self.cfg, token, account_id, None)
        add_log("settings", "Cloudflare 凭据已保存（Token %s）" % ("已更新" if token else "未改动"))
        self._api_cf_status()

    def _api_cf_verify(self) -> None:
        body = self._read_body()
        token = str(body.get("api_token") or "").strip() or str(self.cfg["cloudflare"].get("api_token") or "").strip()
        account_id = str(body.get("account_id") or "").strip() or str(self.cfg["cloudflare"].get("account_id") or "").strip()
        if not token:
            self._send_error_json(400, "请先填写 API Token")
            return
        client = CloudflareClient(token, account_id)
        report: Dict[str, Any] = {
            "token_valid": False, "token_status": "",
            "account_id": account_id, "accounts": [], "zones": [],
            "tunnels_readable": False, "errors": [], "warnings": [],
        }
        # 1) Token 本身
        try:
            info = client.verify_token() or {}
            report["token_valid"] = True
            report["token_status"] = (info.get("status") if isinstance(info, dict) else "") or "active"
        except CloudflareError as exc:
            report["errors"].append("Token 验证失败：" + str(exc))
            add_log("verify", "Token 无效：" + str(exc), "warn")
            self._send_json({"ok": False, "report": report})
            return
        # 2) 账号发现（单一账号时自动落盘）
        try:
            accounts = client.list_accounts()
            report["accounts"] = accounts
            if not report["account_id"] and len(accounts) == 1:
                report["account_id"] = accounts[0]["id"]
                update_cloudflare_settings(self.cfg, account_id=accounts[0]["id"])
            elif not report["account_id"] and len(accounts) > 1:
                report["warnings"].append("检测到多个账号，请在下方选择 Account ID")
            elif accounts and report["account_id"] and all(a["id"] != report["account_id"] for a in accounts):
                report["warnings"].append("当前 Account ID 不在 Token 可见账号列表中，请检查")
        except CloudflareError as exc:
            report["warnings"].append("账号列表获取失败（不影响已填 Account ID 的使用）：" + str(exc))
        # 3) 域名列表（供默认 Zone 下拉；无区域权限时降级为警告）
        if report["account_id"]:
            client.account_id = report["account_id"]
            try:
                report["zones"] = client.list_zones()
            except CloudflareError as exc:
                report["warnings"].append("域名列表获取失败（可能缺少「区域 → 区域 读取」权限）：" + str(exc))
            # 4) 隧道读取权限实测
            try:
                report["tunnels_readable"] = True
                report["tunnel_count"] = len(client.list_tunnels())
            except CloudflareError as exc:
                report["errors"].append("隧道列表读取失败（检查「账户 → Cloudflare Tunnel 读取」权限）：" + str(exc))
        add_log("verify", "Token 有效，账号 " + (report["account_id"] or "未确定"))
        self._send_json({"ok": True, "report": report})

    def _api_cf_zones(self) -> None:
        cf = self.cfg["cloudflare"]
        if not cf.get("api_token"):
            self._send_json({"ok": True, "configured": False, "zones": [], "primary_zone": ""})
            return
        client = CloudflareClient(cf["api_token"], cf.get("account_id") or "")
        try:
            zones = client.list_zones()
        except CloudflareError as exc:
            self._send_json({"ok": False, "configured": True, "error": str(exc), "zones": [], "primary_zone": cf.get("primary_zone") or ""})
            return
        self._send_json({"ok": True, "configured": True, "zones": zones, "primary_zone": cf.get("primary_zone") or ""})

    def _api_cf_zones_primary_save(self) -> None:
        body = self._read_body()
        zone_id = str(body.get("zone_id") or "").strip()
        name = str(body.get("name") or "").strip()
        if not zone_id:
            self._send_error_json(400, "请选择域名")
            return
        update_cloudflare_settings(self.cfg, primary_zone=zone_id)
        add_log("dns", "设置目标 Zone：" + (name or zone_id))
        self._send_json({"ok": True, "primary_zone": zone_id})

    # ---- 系统设置（连接器参数，M4 生效） ----

    def _api_system_settings_get(self) -> None:
        self._send_json({
            "ok": True,
            "connector": self.cfg.get("connector", {}),
            "panel": {"no_auth_run": bool(self.cfg["panel"].get("no_auth_run"))},
        })

    def _api_system_settings_save(self) -> None:
        body = self._read_body()
        # 只更新显式传入的字段：缺省字段保持原值，避免部分更新把其它配置重置回默认
        conn_cfg = self.cfg.setdefault("connector", {})
        changed = {}

        if "auto_connect" in body:
            changed["auto_connect"] = bool(body.get("auto_connect"))
        if "protocol" in body:
            protocol = str(body.get("protocol") or "").strip().lower()
            if protocol not in ("http2", "quic"):
                self._send_error_json(400, "连接协议仅支持 http2 / quic")
                return
            changed["protocol"] = protocol
        if "ip_version" in body:
            ip_version = str(body.get("ip_version") or "").strip().lower()
            if ip_version not in ("ipv4", "ipv6"):
                self._send_error_json(400, "IP 版本仅支持 ipv4 / ipv6")
                return
            changed["ip_version"] = ip_version
        if "watchdog" in body:
            changed["watchdog"] = bool(body.get("watchdog"))
        if "watchdog_max_retry" in body:
            try:
                retry = int(body.get("watchdog_max_retry"))
            except (TypeError, ValueError):
                retry = -1
            if retry < 0 or retry > 50:
                self._send_error_json(400, "最大重试次数需在 0-50 之间")
                return
            changed["watchdog_max_retry"] = retry

        panel_changed: Dict[str, Any] = {}
        was_no_auth = bool(self.cfg["panel"].get("no_auth_run"))
        if "no_auth_run" in body:
            panel_changed["no_auth_run"] = bool(body.get("no_auth_run"))

        if not changed and not panel_changed:
            self._send_error_json(400, "没有需要更新的设置项")
            return

        with _CFG_LOCK:
            conn_cfg.update(changed)
            self.cfg["panel"].update(panel_changed)
            save_config(self.cfg)

        if changed.get("watchdog") is False:
            CONNECTOR.reset_watchdog()

        # 关闭免密时顺手发一个会话，避免保存成功后立刻被踢回登录页
        headers: Dict[str, str] = {}
        if was_no_auth and panel_changed.get("no_auth_run") is False:
            with db_connect() as conn:
                row = conn.execute(
                    "SELECT id FROM users WHERE role='admin' ORDER BY created_at LIMIT 1"
                ).fetchone()
            if row is not None:
                token = create_session(row["id"])
                headers["Set-Cookie"] = (
                    f"{SESSION_COOKIE}={token}; Max-Age={SESSION_MAX_AGE}; "
                    "Path=/; HttpOnly; SameSite=Lax"
                )

        if changed:
            add_log(
                "settings",
                "连接器设置已更新（%s）" % "、".join("%s=%s" % (k, v) for k, v in changed.items()),
            )
        if panel_changed:
            add_log(
                "settings",
                "访问保护已更新（%s）" % ("免密访问开启" if panel_changed.get("no_auth_run") else "免密访问关闭"),
            )
        self._send_json(
            {
                "ok": True,
                "connector": conn_cfg,
                "panel": {"no_auth_run": bool(self.cfg["panel"].get("no_auth_run"))},
            },
            headers=headers,
        )

    def _api_backup_export(self) -> None:
        """导出配置：只含可迁移的业务配置，不含密码、会话密钥。"""
        cf = self.cfg.get("cloudflare", {}) or {}
        conn = self.cfg.get("connector", {}) or {}
        payload = {
            "app": "kay-cftunnle",
            "version": APP_VERSION,
            "exported_at": int(time.time()),
            "cloudflare": {
                "api_token": cf.get("api_token", ""),
                "account_id": cf.get("account_id", ""),
                "primary_zone": cf.get("primary_zone", ""),
            },
            "connector": {
                "auto_connect": bool(conn.get("auto_connect")),
                "protocol": conn.get("protocol", "http2"),
                "ip_version": conn.get("ip_version", "ipv4"),
                "default_tunnel_id": conn.get("default_tunnel_id", ""),
                "watchdog": bool(conn.get("watchdog", True)),
            },
        }
        add_log("backup", "导出配置")
        self._send_json({"ok": True, "backup": payload}, 200)

    def _api_backup_import(self) -> None:
        """导入配置：覆盖 cloudflare / connector 段，不改 auth 与数据库。"""
        body = self._read_body()
        data = body.get("backup") if isinstance(body.get("backup"), dict) else body
        if not isinstance(data, dict) or data.get("app") not in ("kay-cftunnle",) and "cloudflare" not in data:
            self._send_error_json(400, "配置文件格式不正确")
            return
        cf_in = data.get("cloudflare")
        conn_in = data.get("connector")
        if not isinstance(cf_in, dict) and not isinstance(conn_in, dict):
            self._send_error_json(400, "配置文件里没有可导入的内容")
            return
        with _CFG_LOCK:
            cf = self.cfg.setdefault("cloudflare", {})
            if isinstance(cf_in, dict):
                if "api_token" in cf_in:
                    cf["api_token"] = str(cf_in.get("api_token") or "").strip()
                if "account_id" in cf_in:
                    cf["account_id"] = str(cf_in.get("account_id") or "").strip()
                if "primary_zone" in cf_in:
                    cf["primary_zone"] = str(cf_in.get("primary_zone") or "").strip()
            conn = self.cfg.setdefault("connector", {})
            if isinstance(conn_in, dict):
                if "auto_connect" in conn_in:
                    conn["auto_connect"] = bool(conn_in.get("auto_connect"))
                if conn_in.get("protocol") in ("http2", "quic"):
                    conn["protocol"] = conn_in["protocol"]
                if conn_in.get("ip_version") in ("ipv4", "ipv6"):
                    conn["ip_version"] = conn_in["ip_version"]
                if "default_tunnel_id" in conn_in:
                    conn["default_tunnel_id"] = str(conn_in.get("default_tunnel_id") or "").strip()
                if "watchdog" in conn_in:
                    conn["watchdog"] = bool(conn_in.get("watchdog"))
            save_config(self.cfg)
        add_log("backup", "导入配置")
        self._send_json({"ok": True, "cloudflare": {
            "configured": bool(self.cfg["cloudflare"].get("api_token")),
            "account_id": self.cfg["cloudflare"].get("account_id", ""),
        }, "connector": self.cfg.get("connector", {})})

    def _api_system_selfcheck(self) -> None:
        """自检：确认当前进程里跑的代码版本，以及关键路由是否已注册。"""
        try:
            src = open(os.path.abspath(__file__), "r", encoding="utf-8").read()
            code_sha = hashlib.sha256(src.encode("utf-8")).hexdigest()[:12]
        except Exception:
            code_sha = "unknown"
        probes = {
            "/cloudflare/dns-records": "/cloudflare/dns-records" in src,
            "/system/backup": "/system/backup" in src,
            "/system/info": "/system/info" in src,
            "ingress_update": "_api_ingress_update" in src,
            # 路由下发到隧道远程配置是 1.1.0 的核心修复，NAS 上跑旧镜像时这里会是 false
            "/ingresses/sync": "/ingresses/sync" in src,
            "ingress_sync": "_api_ingress_sync" in src,
            "tunnel_route_sync": "_sync_tunnel_ingress" in src,
            "watchdog": "_watchdog_loop" in src,
        }
        self._send_json({
            "ok": True,
            "version": APP_VERSION,
            "code_sha": code_sha,
            "server_file": os.path.abspath(__file__),
            "server_mtime": int(os.path.getmtime(os.path.abspath(__file__))),
            "started_at": int(START_TIME),
            "pid": os.getpid(),
            "routes_present": probes,
            "all_routes_ok": all(probes.values()),
            "static_rev": STATIC_REV,
        })

    def _api_system_info(self) -> None:
        """返回面板运行环境与系统信息。"""
        uptime_seconds = int(time.time() - START_TIME)
        conn_status = CONNECTOR.status()
        # 找出当前运行中的隧道名称（如果配置了的话）
        current_tunnel_name = ""
        if conn_status.get("running") and conn_status.get("current_tunnel_id"):
            current_id = conn_status["current_tunnel_id"]
            try:
                client = self._cf_client()
                if client:
                    for tunnel in client.list_tunnels():
                        if tunnel.get("id") == current_id:
                            current_tunnel_name = tunnel.get("name", "")
                            break
            except Exception:
                pass
        self._send_json({
            "ok": True,
            "version": APP_VERSION,
            "uptime_seconds": uptime_seconds,
            "data_dir": str(DATA_DIR),
            "runtime_dir": str(RUNTIME_DIR),
            "cloudflared_version": CONNECTOR.get_binary_version(),
            "pid": os.getpid(),
            "python_version": "%d.%d.%d" % sys.version_info[:3],
            "platform": sys.platform,
            "started_at": int(START_TIME),
            "connector": {
                "running": conn_status.get("running", False),
                "current_tunnel_id": conn_status.get("current_tunnel_id", ""),
                "current_tunnel_name": current_tunnel_name,
                "default_tunnel_id": conn_status.get("default_tunnel_id", ""),
            },
        })

    # ---- 隧道 ----

    def _cf_client(self) -> Optional[CloudflareClient]:
        cf = self.cfg["cloudflare"]
        if not cf.get("api_token"):
            return None
        return CloudflareClient(cf["api_token"], cf.get("account_id") or "")

    def _api_tunnels_list(self) -> None:
        client = self._cf_client()
        if client is None:
            self._send_json({"ok": True, "configured": False, "tunnels": []})
            return
        try:
            tunnels = client.list_tunnels()
        except CloudflareError as exc:
            add_log("tunnels", "列表获取失败：" + str(exc), "warn")
            self._send_json({"ok": False, "configured": True, "error": str(exc), "tunnels": []})
            return
        # 叠加本地连接器状态：哪个 tunnel_id 正在由本机 cloudflared 运行
        try:
            conn_status = CONNECTOR.status()
            local_running = conn_status.get("running", False)
            local_tunnel_id = conn_status.get("current_tunnel_id", "")
        except Exception:
            local_running = False
            local_tunnel_id = ""
        for tunnel in tunnels:
            tunnel["local_running"] = local_running and tunnel["id"] == local_tunnel_id
        self._send_json({"ok": True, "configured": True, "tunnels": tunnels})

    def _api_tunnel_create(self) -> None:
        body = self._read_body()
        name = str(body.get("name") or "").strip()
        if not name:
            self._send_error_json(400, "隧道名称不能为空")
            return
        if not re.fullmatch(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?", name):
            self._send_error_json(400, "隧道名称只能包含小写字母、数字与连字符，1-63 位，且不能以连字符开头或结尾")
            return
        client = self._cf_client()
        if client is None:
            self._send_error_json(400, "尚未配置 Cloudflare 凭据")
            return
        try:
            tunnel = client.create_tunnel(name)
        except CloudflareError as exc:
            add_log("tunnels", "创建失败：" + str(exc), "warn")
            self._send_error_json(400, str(exc))
            return
        add_log("tunnels", "创建隧道 " + name)
        self._send_json({"ok": True, "tunnel": tunnel})

    def _api_tunnel_delete(self, tunnel_id: str) -> None:
        client = self._cf_client()
        if client is None:
            self._send_error_json(400, "尚未配置 Cloudflare 凭据")
            return
        try:
            client.delete_tunnel(tunnel_id)
        except CloudflareError as exc:
            add_log("tunnels", "删除失败：" + str(exc), "warn")
            self._send_error_json(400, str(exc))
            return
        add_log("tunnels", "删除隧道 " + tunnel_id[:8])
        self._send_json({"ok": True})

    def _api_tunnel_token(self, tunnel_id: str) -> None:
        client = self._cf_client()
        if client is None:
            self._send_error_json(400, "尚未配置 Cloudflare 凭据")
            return
        try:
            token = client.get_tunnel_token(tunnel_id)
        except CloudflareError as exc:
            self._send_error_json(400, str(exc))
            return
        add_log("tunnels", "获取隧道令牌 " + tunnel_id[:8], "warn")
        self._send_json({"ok": True, "token": token})

    # ---- Ingress / DNS（M3） ----

    def _api_ingresses_list(self) -> None:
        cf = self.cfg["cloudflare"]
        if not cf.get("api_token"):
            self._send_json({"ok": True, "configured": False, "ingresses": []})
            return
        client = CloudflareClient(cf["api_token"], cf.get("account_id") or "")
        with db_connect() as conn:
            rows = conn.execute(
                "SELECT id, subdomain, zone_id, zone_name, tunnel_id, tunnel_name, service, "
                "       cf_record_id, created_at, updated_at FROM ingress_rules ORDER BY id DESC"
            ).fetchall()
        ingresses = [dict(r) for r in rows]
        # 附上 CNAME 目标（隧道 argo 域名）与缺失记录标记
        for ing in ingresses:
            ing["cname_target"] = (ing.get("tunnel_id") or "") + ".cfargotunnel.com"
            ing["full_name"] = _rule_hostname(ing.get("subdomain"), ing.get("zone_name"))
        if ingresses:
            zone_ids = sorted({i["zone_id"] for i in ingresses if i.get("zone_id")})
            existing: Dict[str, set] = {}
            for zid in zone_ids:
                try:
                    recs = client.list_dns_records(zid)
                    existing[zid] = {(r.get("name") or "").lower() for r in recs}
                except CloudflareError:
                    existing[zid] = set()
            for ing in ingresses:
                full = _rule_hostname(ing["subdomain"], ing["zone_name"]).lower()
                names = existing.get(ing["zone_id"]) or set()
                ing["dns_missing"] = bool(names) and full not in names
            # 再对照隧道远程配置：DNS 有记录但隧道没这条 hostname 一样打不开
            routes: Dict[str, list] = {}
            for tid in sorted({i["tunnel_id"] for i in ingresses if i.get("tunnel_id")}):
                try:
                    routes[tid] = client.get_tunnel_ingress(tid)
                except CloudflareError:
                    continue  # 拉取失败时不下 route_missing 结论，避免误报
            for ing in ingresses:
                tid = ing.get("tunnel_id") or ""
                if tid not in routes:
                    continue
                full = _rule_hostname(ing["subdomain"], ing["zone_name"]).lower()
                matched = next((r for r in routes[tid]
                                if str(r.get("hostname") or "").lower() == full), None)
                ing["route_missing"] = matched is None
                ing["remote_service"] = (matched or {}).get("service") or ""
        self._send_json({"ok": True, "configured": True, "ingresses": ingresses})

    def _api_ingress_probe(self) -> None:
        """TCP 探测单个本地回源服务（仅回环地址与 unix socket）。"""
        body = self._read_body()
        self._send_json(_probe_service(body.get("service")))

    def _api_ingress_probe_batch(self) -> None:
        """批量探测已保存规则的本地服务；ids 为空表示全部规则。"""
        body = self._read_body()
        raw_ids = body.get("ids")
        ids = [str(x) for x in raw_ids if str(x)] if isinstance(raw_ids, list) else []
        with db_connect() as conn:
            if ids:
                marks = ",".join("?" for _ in ids)
                rows = conn.execute(
                    "SELECT id, service FROM ingress_rules WHERE id IN (%s)" % marks, ids
                ).fetchall()
            else:
                rows = conn.execute("SELECT id, service FROM ingress_rules ORDER BY id DESC").fetchall()
        if not rows:
            self._send_json({"ok": True, "results": []})
            return
        results: List[Dict[str, Any]] = []
        workers = min(8, len(rows))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(_probe_service, row["service"]): row for row in rows}
            for future, row in futures.items():
                try:
                    item = future.result()
                except Exception as exc:  # 单个探测异常不应拖垮整批
                    item = {"ok": False, "error": "探测失败：" + str(exc)}
                item["id"] = str(row["id"])
                results.append(item)
        order = {str(row["id"]): idx for idx, row in enumerate(rows)}
        results.sort(key=lambda x: order.get(x.get("id"), 0))
        self._send_json({"ok": True, "results": results})

    def _upsert_dns_cname(self, client, zone_id: str, full_name: str, cname_target: str) -> str:
        """创建或原地更新同名 CNAME，避免 Cloudflare 81053（记录已存在）。

        逻辑：先按名字精确查一次 → 命中就 PUT 更新（顺带把历史 A/AAAA 记录改写成 CNAME）
        → 没命中才 POST 创建；若创建仍撞「已存在」（查询与创建之间的竞态），再查一次改更新。
        返回最终使用的 DNS 记录 id。
        """
        def _find() -> Optional[Dict[str, Any]]:
            try:
                recs = client.list_dns_records(zone_id, name=full_name)
            except CloudflareError as exc:
                add_log("ingress", "查询 DNS 记录失败：" + str(exc), "warn")
                return None
            for rec in recs:
                if (rec.get("name") or "").lower() == full_name.lower():
                    return rec
            return None

        existing = _find()
        if existing:
            record_id = existing.get("id") or ""
            if existing.get("type") == "CNAME" and (existing.get("content") or "") == cname_target:
                # 已经完全一致，无需再调写接口
                return record_id
            client.update_dns_record(zone_id, record_id, full_name, cname_target, "CNAME", True, 1)
            add_log("ingress", "DNS 记录已存在，改为原地更新：" + full_name)
            return record_id

        try:
            record = client.create_dns_record(zone_id, full_name, cname_target, "CNAME", True, 1)
            return (record.get("id") or "") if isinstance(record, dict) else str(record or "")
        except CloudflareError as exc:
            msg = str(exc).lower()
            if "already exists" not in msg and "81053" not in msg:
                raise
            # 竞态兜底：查询时还没有、创建时已被占用
            race = _find()
            if not race:
                raise
            client.update_dns_record(
                zone_id, race.get("id") or "", full_name, cname_target, "CNAME", True, 1
            )
            add_log("ingress", "DNS 记录并发冲突，已改为原地更新：" + full_name, "warn")
            return race.get("id") or ""

    def _sync_tunnel_ingress(self, client, tunnel_id: str, drop=()):
        """把该隧道的路由整份下发到 Cloudflare 远程配置。

        只建 DNS CNAME 是不够的：边缘按子域名找到隧道后，还要在隧道 config 的
        ingress 里命中同一条 hostname 才会回源，否则请求直接 1033/502。
        Cloudflare 要求最后一条是不带 hostname 的兜底规则。

        PUT 是整份覆盖，会连带删掉用户在 Cloudflare 后台手写的路由，所以下发前先读
        一次当前配置：面板没建过的 hostname 原样保留（同名以本地为准）。drop 用来
        点名「这次就是要把这条删掉」（删除规则 / 换隧道），否则被删的 hostname 会被
        当成后台手写路由而原地复活。
        """
        if not tunnel_id:
            return False, "缺少隧道 ID"
        try:
            remote = client.get_tunnel_ingress(tunnel_id)
        except CloudflareError as exc:
            return False, "读取隧道当前路由失败，已取消下发（避免覆盖后台已有配置）：%s" % exc
        dropped = {str(h).strip().lower() for h in drop if h}
        with db_connect() as conn:
            rows = conn.execute(
                "SELECT subdomain, zone_name, service FROM ingress_rules "
                "WHERE tunnel_id=? ORDER BY id",
                (tunnel_id,),
            ).fetchall()
        local_hosts = {_rule_hostname(r["subdomain"], r["zone_name"]).lower() for r in rows}
        ingress = []
        kept = 0
        for rule in remote:
            host = str(rule.get("hostname") or "").strip().lower()
            service = str(rule.get("service") or "").strip()
            if not host or not service or host in local_hosts or host in dropped:
                continue
            ingress.append({"hostname": host, "service": service})  # 后台手写的路由，面板不动它
            kept += 1
        for r in rows:
            hostname = _rule_hostname(r["subdomain"], r["zone_name"])
            if hostname:
                ingress.append({"hostname": hostname, "service": r["service"]})
        ingress.append({"service": "http_status:404"})
        try:
            client.put_tunnel_ingress(tunnel_id, ingress)
        except CloudflareError as exc:
            add_log("ingress", "隧道路由下发失败：" + str(exc), "error")
            return False, str(exc)
        add_log("ingress", "已下发 %d 条路由到隧道 %s（另保留后台路由 %d 条）"
                % (len(rows), tunnel_id[:8], kept))
        return True, ""

    def _api_ingress_sync(self) -> None:
        """把本地规则重新整份下发到涉及的每条隧道。

        用于修复历史遗留：早期版本只建了 DNS 记录、从没写过隧道配置，
        规则在面板里看着齐了，实际一条都不通。
        """
        client = self._cf_client()
        if client is None:
            self._send_error_json(400, "尚未配置 Cloudflare 凭据")
            return
        with db_connect() as conn:
            tids = [r["tunnel_id"] for r in conn.execute(
                "SELECT DISTINCT tunnel_id FROM ingress_rules WHERE tunnel_id <> ''"
            ).fetchall()]
        if not tids:
            self._send_json({"ok": True, "results": [], "message": "没有需要下发的规则"})
            return
        results = []
        for tid in tids:
            ok, error = self._sync_tunnel_ingress(client, tid)
            results.append({"tunnel_id": tid, "ok": ok, "error": error})
        self._send_json({"ok": all(r["ok"] for r in results), "results": results})

    def _api_ingress_create(self) -> None:
        body = self._read_body()
        subdomain = str(body.get("subdomain") or "").strip().lower() or "@"
        zone_id = str(body.get("zone_id") or "").strip()
        zone_name = str(body.get("zone_name") or "").strip()
        tunnel_id = str(body.get("tunnel_id") or "").strip()
        tunnel_name = str(body.get("tunnel_name") or "").strip()
        service = _normalize_service(body.get("service"))
        if not zone_id or not tunnel_id or not service:
            self._send_error_json(400, "Zone、隧道、本地服务地址均不能为空")
            return
        if subdomain not in ("@", "*") and not re.fullmatch(r"[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?", subdomain):
            self._send_error_json(400, "子域名只能包含小写字母、数字与连字符，1-63 位，且不能以连字符开头或结尾；"
                                       "@ 表示根域名，* 表示泛域名")
            return
        if not _service_ok(service):
            self._send_error_json(400, "本地服务地址协议不受支持（http/https/tcp/tls/ssh/rdp/unix 等）")
            return
        client = self._cf_client()
        if client is None:
            self._send_error_json(400, "尚未配置 Cloudflare 凭据")
            return
        # 校验同一子域名+Zone 不重复
        with db_connect() as conn:
            existing = conn.execute(
                "SELECT id FROM ingress_rules WHERE subdomain=? AND zone_id=?", (subdomain, zone_id)
            ).fetchone()
        if existing:
            self._send_error_json(400, "该子域名在当前 Zone 下已存在")
            return
        full_name = _rule_hostname(subdomain, zone_name)
        cname_target = tunnel_id + ".cfargotunnel.com"
        # 创建 Cloudflare DNS 记录（已存在同名记录时自动改为更新，不再报 81053）
        try:
            record_id = self._upsert_dns_cname(client, zone_id, full_name, cname_target)
        except CloudflareError as exc:
            add_log("ingress", "DNS 记录创建失败：" + str(exc), "warn")
            self._send_error_json(400, "Cloudflare DNS 创建失败：" + str(exc))
            return
        now = int(time.time())
        with db_connect() as conn:
            conn.execute(
                "INSERT INTO ingress_rules(subdomain, zone_id, zone_name, tunnel_id, tunnel_name, "
                "service, cf_record_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (subdomain, zone_id, zone_name, tunnel_id, tunnel_name, service, record_id, now, now),
            )
        add_log("ingress", "创建 %s → %s（隧道 %s）" % (full_name, service, tunnel_name or tunnel_id[:8]))
        synced, sync_error = self._sync_tunnel_ingress(client, tunnel_id)
        self._send_json({"ok": True, "ingress": {"subdomain": subdomain, "full_name": full_name,
                                                  "record_id": record_id},
                         "synced": synced, "sync_error": sync_error})

    def _api_ingress_update(self, ingress_id: str) -> None:
        """就地更新 Ingress 规则：本地服务地址 / 隧道。

        DNS 记录用 PUT 原地更新，不删重建，避免解析出现短暂中断。
        """
        body = self._read_body()
        service = _normalize_service(body.get("service"))
        tunnel_id = str(body.get("tunnel_id") or "").strip()
        tunnel_name = str(body.get("tunnel_name") or "").strip()
        if not service:
            self._send_error_json(400, "本地服务地址不能为空")
            return
        if not _service_ok(service):
            self._send_error_json(400, "本地服务地址协议不受支持（http/https/tcp/tls/ssh/rdp/unix 等）")
            return
        client = self._cf_client()
        if client is None:
            self._send_error_json(400, "尚未配置 Cloudflare 凭据")
            return
        with db_connect() as conn:
            row = conn.execute(
                "SELECT subdomain, zone_id, zone_name, tunnel_id, tunnel_name, service, cf_record_id "
                "FROM ingress_rules WHERE id=?", (ingress_id,)
            ).fetchone()
        if not row:
            self._send_error_json(404, "规则不存在")
            return

        new_tunnel_id = tunnel_id or row["tunnel_id"]
        new_tunnel_name = tunnel_name or row["tunnel_name"]
        full_name = _rule_hostname(row["subdomain"], row["zone_name"])
        cname_target = new_tunnel_id + ".cfargotunnel.com"
        new_record_id = row["cf_record_id"]

        # 仅当隧道变化时才需要改 DNS；否则纯本地服务地址变更不必碰 Cloudflare
        if new_tunnel_id != row["tunnel_id"]:
            updated = False
            if row["cf_record_id"]:
                try:
                    client.update_dns_record(
                        row["zone_id"], row["cf_record_id"], full_name, cname_target, "CNAME", True, 1
                    )
                    updated = True
                except CloudflareError as exc:
                    # 记录可能在 Cloudflare 后台被手工删除，PUT 会 404：
                    # 此时退化为重新创建，而不是把错误抛给用户
                    add_log("ingress", "DNS 记录原地更新失败，尝试重建：" + str(exc), "warn")
            if not updated:
                try:
                    # 记录可能被手工删除：走 upsert，存在则更新、不存在才创建
                    new_record_id = self._upsert_dns_cname(client, row["zone_id"], full_name, cname_target)
                except CloudflareError as exc:
                    add_log("ingress", "DNS 记录重建失败：" + str(exc), "warn")
                    self._send_error_json(400, "Cloudflare DNS 更新失败：" + str(exc))
                    return

        now = int(time.time())
        with db_connect() as conn:
            conn.execute(
                "UPDATE ingress_rules SET service=?, tunnel_id=?, tunnel_name=?, cf_record_id=?, updated_at=? "
                "WHERE id=?",
                (service, new_tunnel_id, new_tunnel_name, new_record_id, now, ingress_id),
            )
        add_log("ingress", "更新规则 %s → %s" % (full_name, service))
        synced, sync_error = self._sync_tunnel_ingress(client, new_tunnel_id)
        if row["tunnel_id"] and row["tunnel_id"] != new_tunnel_id:
            # 换隧道后旧隧道里仍留着这条 hostname，要把它从旧隧道路由里摘掉再重下
            self._sync_tunnel_ingress(client, row["tunnel_id"], drop=(full_name,))
        self._send_json({"ok": True, "ingress": {
            "id": ingress_id, "full_name": full_name, "service": service,
            "tunnel_id": new_tunnel_id, "tunnel_name": new_tunnel_name,
        }, "synced": synced, "sync_error": sync_error})

    def _api_dns_records_list(self) -> None:
        """列出当前 Zone 的全部 DNS 记录，并标注哪些由本面板维护。"""
        cf = self.cfg["cloudflare"]
        zone_id = str(cf.get("primary_zone") or "").strip()
        if not cf.get("api_token") or not zone_id:
            self._send_json({"ok": True, "configured": False, "records": [], "managed_count": 0})
            return
        client = CloudflareClient(cf["api_token"], cf.get("account_id") or "")
        try:
            records = client.list_dns_records(zone_id)
        except CloudflareError as exc:
            self._send_json({"ok": False, "configured": True, "error": str(exc), "records": []})
            return
        with db_connect() as conn:
            rows = conn.execute(
                "SELECT id, subdomain, zone_name, cf_record_id FROM ingress_rules WHERE zone_id=?", (zone_id,)
            ).fetchall()
        # 用 record_id 与「子域名全名」双重匹配，兼容早期未落 record_id 的情况。
        # 同时带上规则 id，DNS 页可以直接跳回对应规则。
        rule_by_record = {r["cf_record_id"]: r["id"] for r in rows if r["cf_record_id"]}
        rule_by_name = {_rule_hostname(r["subdomain"], r["zone_name"]).lower(): r["id"] for r in rows}
        for rec in records:
            rule_id = rule_by_record.get(rec["id"]) or rule_by_name.get(rec["name"].lower())
            rec["managed"] = rule_id is not None
            rec["rule_id"] = str(rule_id) if rule_id is not None else ""
        managed_count = sum(1 for r in records if r["managed"])
        self._send_json({
            "ok": True, "configured": True, "records": records,
            "managed_count": managed_count, "total": len(records),
        })

    def _api_ingress_delete(self, ingress_id: str) -> None:
        client = self._cf_client()
        if client is None:
            self._send_error_json(400, "尚未配置 Cloudflare 凭据")
            return
        with db_connect() as conn:
            row = conn.execute(
                "SELECT zone_id, cf_record_id, subdomain, zone_name, service, tunnel_id "
                "FROM ingress_rules WHERE id=?",
                (ingress_id,),
            ).fetchone()
        if not row:
            self._send_error_json(404, "规则不存在")
            return
        zone_id = row["zone_id"]
        record_id = row["cf_record_id"]
        # 清理 Cloudflare DNS 记录
        if record_id:
            try:
                client.delete_dns_record(zone_id, record_id)
            except CloudflareError as exc:
                add_log("ingress", "DNS 记录删除失败：" + str(exc), "warn")
                # 继续删除本地记录，避免卡死
        with db_connect() as conn:
            conn.execute("DELETE FROM ingress_rules WHERE id=?", (ingress_id,))
        add_log("ingress", "删除 %s → %s" % (_rule_hostname(row["subdomain"], row["zone_name"]), row["service"]))
        # 点名要删的 hostname，否则它会被当成后台手写路由原地保留下来
        synced, sync_error = self._sync_tunnel_ingress(
            client, row["tunnel_id"], drop=(_rule_hostname(row["subdomain"], row["zone_name"]),))
        self._send_json({"ok": True, "synced": synced, "sync_error": sync_error})

    # ---- 连接器（M4） ----

    def _api_connector_status(self) -> None:
        self._send_json(CONNECTOR.status())

    def _api_connector_events(self) -> None:
        query = parse_qs(urlparse(self.path).query)
        try:
            hours = int((query.get("hours") or ["24"])[0])
        except ValueError:
            hours = 24
        try:
            limit = int((query.get("limit") or ["40"])[0])
        except ValueError:
            limit = 40
        payload = connector_events(hours, limit)
        payload["ok"] = True
        self._send_json(payload)

    def _api_connector_start(self) -> None:
        body = self._read_body()
        tunnel_id = str(body.get("tunnel_id") or "").strip()
        # 单连接器模型：已经连着另一条隧道时，先断开再切过去，
        # 否则 start() 会直接返回「连接器已在运行中」
        status = CONNECTOR.status()
        if status.get("running") and tunnel_id:
            current = status.get("current_tunnel_id") or ""
            if current != tunnel_id:
                CONNECTOR.stop(by_user=False)
                add_log("connector", "切换到隧道 " + tunnel_id[:8])
        CONNECTOR.reset_watchdog()
        result = CONNECTOR.start(tunnel_id)
        if result.get("ok"):
            self._send_json(result)
        else:
            self._send_error_json(400, result.get("error", "启动失败"))

    def _api_connector_stop(self) -> None:
        self._send_json(CONNECTOR.stop(by_user=True))

    def _api_connector_restart(self) -> None:
        body = self._read_body()
        tunnel_id = str(body.get("tunnel_id") or "").strip()
        CONNECTOR.reset_watchdog()
        result = CONNECTOR.restart(tunnel_id)
        if result.get("ok"):
            self._send_json(result)
        else:
            self._send_error_json(400, result.get("error", "重启失败"))

    def _api_connector_default(self) -> None:
        body = self._read_body()
        tunnel_id = str(body.get("tunnel_id") or "").strip()
        if not tunnel_id:
            self._send_error_json(400, "请选择默认隧道")
            return
        with _CFG_LOCK:
            conn_cfg = self.cfg.setdefault("connector", {})
            conn_cfg["default_tunnel_id"] = tunnel_id
            save_config(self.cfg)
        add_log("connector", "设置默认隧道 " + tunnel_id[:8])
        self._send_json({"ok": True, "default_tunnel_id": tunnel_id})

    # ---- 日志 / 改密 ----

    def _api_logs(self) -> None:
        query = parse_qs(urlparse(self.path).query)
        try:
            limit = int((query.get("limit") or ["20"])[0])
        except ValueError:
            limit = 20
        self._send_json({"ok": True, "logs": recent_logs(limit)})

    def _api_change_password(self) -> None:
        body = self._read_body()
        old_pass = str(body.get("old_password") or "")
        new_pass = str(body.get("new_password") or "")
        if not old_pass or not new_pass:
            self._send_error_json(400, "当前密码和新密码不能为空")
            return
        if len(new_pass) < 8:
            self._send_error_json(400, "新密码至少 8 位")
            return
        user = self._current_user()
        if user is None:
            self._send_error_json(401, "未登录")
            return
        with db_connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
            if row is None or not verify_password(old_pass, row["salt"], row["pass_hash"]):
                self._send_error_json(400, "当前密码不正确")
                return
            salt = secrets.token_hex(16)
            conn.execute(
                "UPDATE users SET pass_hash=?, salt=? WHERE id=?",
                (hash_password(new_pass, salt), salt, user["id"]),
            )
            # 同步回 workbench.json，避免重启后 db_init 用旧密码覆盖
            self.cfg["auth"]["password"] = new_pass
            with _CFG_LOCK:
                save_config(self.cfg)
            # 吊销该用户全部会话（含当前连接），强制重新登录
            conn.execute("DELETE FROM sessions WHERE user_id=?", (user["id"],))
        add_log("password", "管理员密码已修改，所有会话已吊销")
        self._send_json({"ok": True})

    # ------------------------------------------------------------ 静态资源

    def _serve_static(self, path: str, head_only: bool) -> None:
        if path in ("/", ""):
            path = "/index.html"
        # 防目录穿越：规整化后必须以 STATIC_DIR 开头
        target = (STATIC_DIR / path.lstrip("/")).resolve()
        try:
            target.relative_to(STATIC_DIR.resolve())
        except ValueError:
            self._send_error_json(403, "forbidden")
            return
        if not target.is_file():
            self._send_error_json(404, "not found")
            return
        ctype = CONTENT_TYPES.get(target.suffix.lower())
        if not ctype:
            ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        data = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if not head_only:
            self.wfile.write(data)


# ------------------------------------------------------------------ 自检

def self_check(cfg: Dict[str, Any]) -> Dict[str, Any]:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    # 与连接器启动共用同一个查找逻辑，避免自检说「未安装」、启动却能正常拉起
    cloudflared_ok = bool(CONNECTOR.find_binary())
    with db_connect() as conn:
        users = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
    return {
        "ok": True,
        "service": "kay-cftunnle",
        "timezone": os.environ.get("DASHBOARD_TZ", "Asia/Shanghai"),
        "now": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "config": str(CONFIG_PATH),
        "database": str(DB_PATH),
        "users": users,
        "cloudflared_binary": cloudflared_ok,
        "cloudflare_configured": bool(cfg["cloudflare"].get("api_token")),
        "connector": cfg.get("connector", {}),
        "connector_running": CONNECTOR.status().get("running", False),
    }


# 连接器单例（实际配置在 main() 中替换）
CONNECTOR = ConnectorManager({"connector": DEFAULT_CONFIG["connector"]})


# ------------------------------------------------------------------ 入口

def main() -> None:
    parser = argparse.ArgumentParser(description="Kay-cftunnle 服务端")
    parser.add_argument("--host", default=os.environ.get("DASHBOARD_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("DASHBOARD_PORT", "8567")))
    parser.add_argument("--check", action="store_true", help="只打印一次状态 JSON 后退出")
    args = parser.parse_args()

    cfg = load_config()
    db_init(cfg)

    # 让连接器使用加载后的真实配置
    CONNECTOR.cfg = cfg

    if args.check:
        print(json.dumps(self_check(cfg), ensure_ascii=False, indent=2))
        return

    PanelHandler.cfg = cfg

    # M4：若开启自动连接，尝试在 HTTP 服务启动前拉起 cloudflared
    CONNECTOR.auto_connect()
    # 看门狗：进程意外退出后自动拉起，NAS 长期挂机的稳定性保障
    CONNECTOR.start_watchdog()

    server = ThreadingHTTPServer((args.host, args.port), PanelHandler)
    print(f"[*] Kay-cftunnle 已启动: http://{args.host}:{args.port}", flush=True)
    print(f"[*] 配置: {CONFIG_PATH}", flush=True)
    if cfg["panel"].get("no_auth_run"):
        print(f"[*] 已开启无密码模式，浏览器打开即可直接使用", flush=True)
    else:
        print(f"[*] 默认账号: {cfg['auth']['username']}（登录后请立即修改密码）", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] 正在停止…", flush=True)
        server.shutdown()


if __name__ == "__main__":
    main()
