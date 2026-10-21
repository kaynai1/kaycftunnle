#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 EasonShu
"""Kay-cftunnle 本地授权状态 —— 机器码、激活、在线校验、离线授权码。

设计原则：
  * 一码一机：在线卡密在 Worker 侧绑定机器码，离线授权码用 Ed25519 签名绑定。
  * 两种激活：在线卡密（KAY-）需要联网；离线授权码（KAYO-）本地验签即可，
    纯内网/断网/境外都能激活，联网时只向授权服务报到一次以支持远程吊销。
  * 断网可用：在线校验成功后在宽限期内照常使用；离线授权本身不依赖网络。
  * 吊销即停：Worker 明确返回吊销/设备不符时立刻锁定，不进入宽限。

磁盘文件（均在 data/ 下，权限 0600）：
  license.json   授权模式、卡密或离线授权码、最近校验时间、锁定原因
  machine_id     硬件指纹缓存，保证容器重建后机器码不变
"""

import hashlib
import json
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, Optional
from urllib.parse import urlparse

import license_ed25519

CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
CODE_RE = re.compile(r"^KAY-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$")
DEFAULT_VERIFY_INTERVAL = 6 * 60 * 60
DEFAULT_RETRY_INTERVAL = 15 * 60
REQUEST_TIMEOUT = 8
LOCK_REASONS = {
    "revoked": "卡密已被吊销",
    "device_mismatch": "卡密已绑定其他设备",
    "not_activated": "卡密未绑定设备",
    "not_found": "卡密不存在或已被删除",
    "expired": "授权已到期",
    "tampered": "授权文件校验失败",
}

# 离线授权码：22 字节载荷 + 64 字节 Ed25519 签名，Crockford Base32 + KAYO 前缀。
# 字段布局与 license-worker/src/offline.mjs 必须完全一致。
OFFLINE_PREFIX = "KAYO"
OFFLINE_LENGTH = 86
FLAG_ANY_MACHINE = 1
FLAG_PERMANENT = 2
# 由 tools/keygen.mjs 生成的公钥（64 位十六进制）。留空则面板不接受离线授权码。
OFFLINE_PUBLIC_KEY = "912f51c05207343c404ae45e215888dcb85e556fdec7b1e2bf79837fbc82bc1d"

_STATE_DEFAULTS: Dict[str, Any] = {
    "server_url": "",
    "code": "",
    "mode": "online",
    "offline_code": "",
    "serial": 0,
    "expires_at": 0,
    "max_seen_at": 0,
    "machine_code": "",
    "activated_at": 0,
    "bound_at": 0,
    "last_verified_at": 0,
    "last_attempt_at": 0,
    "last_error": "",
    "lock_reason": "",
}


class LicenseError(Exception):
    def __init__(self, message: str, reason: str = "", status: int = 0):
        super().__init__(message)
        self.message = message
        self.reason = reason
        self.status = status


def normalize_code(raw: str) -> str:
    """接受带不带连字符、大小写混杂的卡密，返回标准形式；非法返回空串。"""
    flat = re.sub(r"[^A-Z0-9]", "", str(raw or "").upper())
    if flat.startswith("KAY"):
        flat = flat[3:]
    if len(flat) != 12 or any(ch not in CODE_ALPHABET for ch in flat):
        return ""
    return "KAY-" + "-".join(flat[i:i + 4] for i in range(0, 12, 4))


def mask_code(code: str) -> str:
    if not code or len(code) < 4:
        return ""
    return "KAY-****-****-" + code[-4:]


def mask_offline_code(text: str) -> str:
    flat = re.sub(r"[^0-9A-Z]", "", str(text or "").upper())
    if len(flat) < 20:
        return ""
    return flat[:4] + "-" + flat[4:9] + "-…" + flat[-5:]


# --------------------------------------------------------------- 离线授权码

def _b32_encode(data: bytes) -> str:
    value = int.from_bytes(data, "big")
    bits = len(data) * 8
    chars = []
    for offset in range(0, bits - bits % 5, 5):
        chars.append(CODE_ALPHABET[(value >> (bits - offset - 5)) & 31])
    remainder = bits % 5
    if remainder:
        chars.append(CODE_ALPHABET[(value << (5 - remainder)) & 31])
    return "".join(chars)


def _b32_decode(text: str) -> Optional[bytes]:
    value = 0
    bits = 0
    out = bytearray()
    for ch in text:
        index = CODE_ALPHABET.find(ch)
        if index < 0:
            return None
        value = (value << 5) | index
        bits += 5
        if bits >= 8:
            bits -= 8
            out.append((value >> bits) & 0xFF)
    return bytes(out)


def _pack_machine(machine_code: str) -> bytes:
    chars = re.sub(r"[^0-9A-Z]", "", str(machine_code or "").upper())
    if chars.startswith("NAS"):
        chars = chars[3:]
    if len(chars) != 12 or any(ch not in CODE_ALPHABET for ch in chars):
        raise ValueError("机器码格式不正确，应形如 NAS-XXXX-XXXX-XXXX")
    value = 0
    for ch in chars:
        value = (value << 5) | CODE_ALPHABET.index(ch)
    return value.to_bytes(8, "big")


def _unpack_machine(raw: bytes) -> str:
    value = int.from_bytes(raw, "big")
    chars = "".join(CODE_ALPHABET[(value >> (5 * (11 - i))) & 31] for i in range(12))
    return "NAS-" + chars[:4] + "-" + chars[4:8] + "-" + chars[8:12]


def normalize_offline_code(raw: str) -> str:
    """把离线授权码整理成 KAYO-XXXXX-… 标准形式；不像离线码时返回空串。"""
    flat = re.sub(r"[^0-9A-Z]", "", str(raw or "").upper())
    if not flat.startswith(OFFLINE_PREFIX):
        return ""
    body = _b32_encode(_b32_decode(flat[len(OFFLINE_PREFIX):]) or b"")
    if len(body) != 138:
        return ""
    groups = [body[i:i + 5] for i in range(0, len(body), 5)]
    return OFFLINE_PREFIX + "-" + "-".join(groups)


def decode_offline_license(text: str) -> Optional[Dict[str, Any]]:
    flat = re.sub(r"[^0-9A-Z]", "", str(text or "").upper())
    if not flat.startswith(OFFLINE_PREFIX):
        return None
    raw = _b32_decode(flat[len(OFFLINE_PREFIX):])
    if raw is None or len(raw) != OFFLINE_LENGTH:
        return None
    payload = raw[:22]
    if payload[0] != 1:
        return None
    flags = payload[1]
    return {
        "version": payload[0],
        "flags": flags,
        "machine": "" if flags & FLAG_ANY_MACHINE else _unpack_machine(payload[2:10]),
        "serial": int.from_bytes(payload[10:14], "big"),
        "issued_at": int.from_bytes(payload[14:18], "big"),
        "expires_at": int.from_bytes(payload[18:22], "big"),
        "payload": payload,
        "signature": raw[22:],
        "text": normalize_offline_code(flat),
    }


def verify_offline_license(text: str, machine_code: str,
                           public_key: Optional[bytes] = None,
                           now: Optional[int] = None) -> Dict[str, Any]:
    """校验离线授权码的签名、绑定机器与有效期。"""
    key = public_key if public_key is not None else (
        license_ed25519.public_key_from_hex(OFFLINE_PUBLIC_KEY) if OFFLINE_PUBLIC_KEY else b""
    )
    if not key:
        return {"ok": False, "reason": "offline_disabled",
                "error": "本面板未内置离线授权公钥，请使用在线卡密激活"}
    parsed = decode_offline_license(text)
    if not parsed:
        return {"ok": False, "reason": "invalid_offline",
                "error": "离线授权码格式不正确，请完整粘贴（以 KAYO 开头）"}
    if not license_ed25519.verify(parsed["payload"], parsed["signature"], key):
        return {"ok": False, "reason": "bad_signature",
                "error": "离线授权码无效：签名校验未通过，请确认是本机对应的那一份"}
    reference = int(time.time()) if now is None else int(now)
    if not (parsed["flags"] & FLAG_ANY_MACHINE) and parsed["machine"] != machine_code:
        return {"ok": False, "reason": "device_mismatch",
                "error": "这份授权码绑定的是另一台设备（%s），不能在本机使用" % parsed["machine"]}
    if parsed["expires_at"] and reference > parsed["expires_at"]:
        return {"ok": False, "reason": "expired", "error": "离线授权已于到期时间失效，请联系卖家续期"}
    return {"ok": True, "license": parsed}


def _read_first_line(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.readline().strip()
    except Exception:
        return ""


def _usable_fingerprint(value: str) -> bool:
    value = str(value or "").strip()
    if len(value) < 8:
        return False
    low = value.lower()
    if low in {
        "none", "unknown", "default string", "to be filled by o.e.m.",
        "00000000-0000-0000-0000-000000000000",
        "03000200-0400-0500-0006-000700080009",
    }:
        return False
    return bool(set(low) - {"0", "-"})


def _fingerprint_source(data_dir: Path) -> str:
    """首次解析硬件指纹后缓存到 data/machine_id，容器重建/系统升级后机器码不变。"""
    cache = Path(data_dir) / "machine_id"
    cached = _read_first_line(str(cache))
    if _usable_fingerprint(cached):
        # 兼容旧格式：旧文件只有随机值，没有 "来源:" 前缀
        return cached if ":" in cached else "persisted:" + cached

    for label, path in (
        ("dmi", "/sys/class/dmi/id/product_uuid"),
        ("board", "/sys/class/dmi/id/board_serial"),
        ("machine-id", "/etc/machine-id"),
        ("dbus-id", "/var/lib/dbus/machine-id"),
    ):
        value = _read_first_line(path)
        if _usable_fingerprint(value):
            fingerprint = label + ":" + value
            _atomic_write(cache, fingerprint + "\n")
            return fingerprint

    # 取 32 位随机 hex，仅用于生成不可猜测的机器码，不是安全凭据
    fingerprint = "persisted:" + secrets.token_hex(16)
    _atomic_write(cache, fingerprint + "\n")
    return fingerprint


def compute_machine_code(data_dir: Path) -> str:
    digest = hashlib.sha256(_fingerprint_source(data_dir).encode("utf-8")).digest()
    chars = "".join(CODE_ALPHABET[b % 32] for b in digest[:12])
    return "NAS-" + "-".join(chars[i:i + 4] for i in range(0, 12, 4))


def normalize_server_url(raw: str) -> str:
    url = str(raw or "").strip().rstrip("/")
    if not url:
        return ""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("授权服务地址必须是以 http:// 或 https:// 开头的完整地址")
    if parsed.scheme == "http" and parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("公网授权服务必须使用 https://")
    return url


def _atomic_write(path: Path, text: str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    try:
        os.chmod(tmp, 0o600)
    except Exception:
        pass
    os.replace(tmp, path)


class LicenseManager:
    def __init__(
        self,
        data_dir: Path,
        default_server_url: str = "",
        verify_interval: int = DEFAULT_VERIFY_INTERVAL,
        grace_days: int = 7,
        timeout: int = REQUEST_TIMEOUT,
        on_locked: Optional[Callable[[str, str], None]] = None,
    ):
        self.data_dir = Path(data_dir)
        self.state_path = self.data_dir / "license.json"
        self.default_server_url = str(default_server_url or "").strip().rstrip("/")
        self.verify_interval = max(300, int(verify_interval))
        self.grace_days = min(max(int(grace_days), 1), 90)
        self.grace_seconds = self.grace_days * 86400
        self.timeout = max(2, int(timeout))
        self.on_locked = on_locked
        self.machine_code = compute_machine_code(self.data_dir)
        self.lock = threading.RLock()
        self._state = self._load()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._verifying = False
        self._lock_notified = ""
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        if not self._state.get("machine_code"):
            self._state["machine_code"] = self.machine_code
            self._save()
        self._revalidate_offline()

    # ------------------------------------------------------------ 状态持久化

    def _load(self) -> Dict[str, Any]:
        state = dict(_STATE_DEFAULTS)
        if self.state_path.is_file():
            try:
                stored = json.loads(self.state_path.read_text(encoding="utf-8"))
                if isinstance(stored, dict):
                    for key in _STATE_DEFAULTS:
                        if key in stored:
                            state[key] = stored[key]
            except Exception as exc:
                print("[!] license.json 解析失败（%s），按未激活处理" % exc, file=sys.stderr)
        for key in ("activated_at", "bound_at", "last_verified_at", "last_attempt_at",
                    "expires_at", "serial", "max_seen_at"):
            try:
                state[key] = int(state.get(key) or 0)
            except (TypeError, ValueError):
                state[key] = 0
        state["code"] = normalize_code(str(state.get("code") or "")) or ""
        state["offline_code"] = normalize_offline_code(str(state.get("offline_code") or "")) or ""
        if state.get("mode") not in ("online", "offline"):
            state["mode"] = "online"
        if state["mode"] == "offline" and not state["offline_code"]:
            state["mode"] = "online"
        state["machine_code"] = self.machine_code
        return state

    def _revalidate_offline(self) -> None:
        """启动时重新验签，防止有人手改 license.json 里的到期时间或序列号。"""
        with self.lock:
            if self._state.get("mode") != "offline" or not self._state.get("offline_code"):
                return
            result = verify_offline_license(
                self._state["offline_code"], self.machine_code,
                now=int(self._state.get("max_seen_at") or time.time()),
            )
            if result["ok"]:
                lic = result["license"]
                self._state["serial"] = lic["serial"]
                self._state["expires_at"] = lic["expires_at"]
                if not self._state.get("lock_reason"):
                    return
                self._state["lock_reason"] = ""
                self._save()
                return
            self._state["offline_code"] = ""
            self._state["mode"] = "online"
            self._state["lock_reason"] = ""
            self._state["last_error"] = result["error"]
            if result["reason"] == "expired":
                self._state["lock_reason"] = "expired"
            self._save()

    def _save(self) -> None:
        _atomic_write(self.state_path, json.dumps(self._state, ensure_ascii=False, indent=2) + "\n")

    # ------------------------------------------------------------ 访问器

    def server_url(self) -> str:
        with self.lock:
            return (
                str(self._state.get("server_url") or "").strip()
                or self.default_server_url
                or os.environ.get("KAY_LICENSE_URL", "").strip().rstrip("/")
            )

    def set_server_url(self, raw: str) -> Dict[str, Any]:
        url = normalize_server_url(raw)
        with self.lock:
            if self._state.get("code"):
                return {"ok": False, "error": "面板已激活，不能直接修改授权服务地址"}
            self._state["server_url"] = url
            self._state["last_error"] = ""
            self._save()
        return {"ok": True, "server_url": url}

    def status(self) -> Dict[str, Any]:
        now = int(time.time())
        with self.lock:
            state = dict(self._state)
            # 记录见过的最大时间，防止把系统时钟调回过去来延长离线授权；每小时落盘一次
            if now - int(state.get("max_seen_at") or 0) >= 3600:
                self._state["max_seen_at"] = now
                state["max_seen_at"] = now
                self._save()
        code = state.get("code") or ""
        offline = state.get("offline_code") or ""
        mode = "offline" if offline and not code else "online"
        activated = bool(code or offline)
        locked = state.get("lock_reason") or ""
        last = int(state.get("last_verified_at") or 0)
        age = now - last if last else 0
        grace_left = 0
        expires_at = int(state.get("expires_at") or 0) if mode == "offline" else 0
        verify_due_at = last + self.verify_interval

        if not activated:
            state_name = "unactivated"
            valid = False
            message = "面板尚未激活，请输入卡密或离线授权码"
        elif locked:
            state_name = "revoked" if locked == "revoked" else "invalid"
            valid = False
            message = LOCK_REASONS.get(locked, "授权已失效")
            if locked == "revoked":
                message = "离线授权已被吊销，面板已锁定" if mode == "offline" else "卡密已被吊销，面板已锁定"
            elif locked == "device_mismatch" and mode == "offline":
                message = "授权码已绑定其他设备，面板已锁定，如需换机请联系卖家解绑"
        elif mode == "offline":
            if expires_at and now > expires_at:
                state_name = "expired"
                valid = False
                message = "离线授权已到期，请联系卖家续期"
            else:
                state_name = "active"
                valid = True
                message = "离线授权有效" + (
                    "，剩余 %d 天" % max(1, (expires_at - now) // 86400) if expires_at else "")
        elif not last:
            state_name = "pending"
            valid = False
            message = "等待首次在线校验"
        elif age <= self.verify_interval:
            state_name = "active"
            valid = True
            message = "授权正常"
        else:
            grace_left = max(0, self.grace_seconds - age)
            if grace_left > 0:
                state_name = "grace"
                valid = True
                message = "离线宽限中，剩余 %d 天" % max(1, grace_left // 86400)
            else:
                state_name = "expired"
                valid = False
                message = "离线宽限期已过，请联网校验后继续使用"

        return {
            "ok": True,
            "activated": activated,
            "valid": valid,
            "state": state_name,
            "message": message,
            "mode": mode,
            "machine_code": self.machine_code,
            "code": code,
            "code_masked": mask_offline_code(offline) if mode == "offline" else mask_code(code),
            "serial": int(state.get("serial") or 0) if mode == "offline" else 0,
            "expires_at": expires_at,
            "server_url": self.server_url(),
            "activated_at": int(state.get("activated_at") or 0),
            "bound_at": int(state.get("bound_at") or 0),
            "last_verified_at": last,
            "last_attempt_at": int(state.get("last_attempt_at") or 0),
            "last_error": state.get("last_error") or "",
            "verify_due_at": verify_due_at if activated else 0,
            "verify_interval": self.verify_interval,
            "grace_days": self.grace_days,
            "grace_left_seconds": grace_left,
            "locked": bool(locked),
            "revoked": locked == "revoked",
            "now": now,
        }

    def is_valid(self) -> bool:
        return bool(self.status().get("valid"))

    # ------------------------------------------------------------ 网络请求

    def _post(self, path: str, payload: Dict[str, Any], base_url: Optional[str] = None) -> Dict[str, Any]:
        base = (base_url or self.server_url()).rstrip("/")
        if not base:
            raise LicenseError("尚未配置授权服务地址", "no_server", 0)
        request = urllib.request.Request(
            base + path,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "User-Agent": "Kay-cftunnle/1.6",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            exc.close()
            try:
                data = json.loads(raw)
            except Exception:
                data = {}
            raise LicenseError(
                str(data.get("error") or "授权服务返回 HTTP %s" % exc.code),
                str(data.get("reason") or "http_%s" % exc.code),
                exc.code,
            )
        except urllib.error.URLError as exc:
            raise LicenseError("无法连接授权服务：%s" % getattr(exc, "reason", exc), "network", 0)
        except Exception as exc:
            raise LicenseError("授权服务请求失败：%s" % exc, "network", 0)
        try:
            data = json.loads(raw)
        except Exception:
            raise LicenseError("授权服务返回内容无法解析", "bad_response", 0)
        if not isinstance(data, dict):
            raise LicenseError("授权服务返回内容格式不正确", "bad_response", 0)
        if data.get("ok") is False:
            raise LicenseError(
                str(data.get("error") or "授权失败"),
                str(data.get("reason") or "failed"),
                0,
            )
        return data

    # ------------------------------------------------------------ 激活 / 校验

    def activate(self, raw_code: str, server_url: Optional[str] = None) -> Dict[str, Any]:
        code = normalize_code(raw_code)
        if not code:
            return {"ok": False, "reason": "invalid_code", "error": "卡密格式不正确，应形如 KAY-XXXX-XXXX-XXXX"}
        try:
            base = normalize_server_url(server_url or self.server_url())
        except ValueError as exc:
            return {"ok": False, "reason": "invalid_server", "error": str(exc)}
        if not base:
            return {"ok": False, "reason": "no_server", "error": "请先填写授权服务地址"}

        with self.lock:
            current = self.status()
            if current["activated"] and current["valid"]:
                return {"ok": False, "reason": "already_activated", "error": "面板已激活，无需重复操作"}

        try:
            data = self._post("/activate", {"code": code, "machine_code": self.machine_code}, base_url=base)
        except LicenseError as exc:
            with self.lock:
                self._state["last_attempt_at"] = int(time.time())
                self._state["last_error"] = exc.message
                if exc.reason in LOCK_REASONS:
                    self._state["lock_reason"] = exc.reason
                self._save()
            return {"ok": False, "reason": exc.reason, "error": exc.message}

        lic = data.get("license") or {}
        now = int(time.time())
        with self.lock:
            self._state.update({
                "server_url": base,
                "code": code,
                "mode": "online",
                "offline_code": "",
                "serial": 0,
                "expires_at": 0,
                "machine_code": self.machine_code,
                "activated_at": int(lic.get("activated_at") or now),
                "bound_at": int(lic.get("bound_at") or now),
                "last_verified_at": now,
                "last_attempt_at": now,
                "last_error": "",
                "lock_reason": "",
            })
            self._save()
        return {"ok": True, "message": "激活成功", "status": self.status()}

    def activate_offline(self, raw_code: str, server_url: Optional[str] = None) -> Dict[str, Any]:
        """离线授权码激活：本地验签即可，不需要联网。"""
        text = normalize_offline_code(raw_code)
        if not text:
            return {"ok": False, "reason": "invalid_offline",
                    "error": "离线授权码格式不正确，请完整粘贴（以 KAYO 开头）"}
        result = verify_offline_license(text, self.machine_code)
        if not result["ok"]:
            return {"ok": False, "reason": result["reason"], "error": result["error"]}
        lic = result["license"]
        now = int(time.time())
        try:
            base = normalize_server_url(server_url or "") if server_url else self.server_url()
        except ValueError as exc:
            return {"ok": False, "reason": "invalid_server", "error": str(exc)}
        with self.lock:
            self._state.update({
                "server_url": base,
                "code": "",
                "mode": "offline",
                "offline_code": text,
                "serial": lic["serial"],
                "expires_at": lic["expires_at"],
                "machine_code": self.machine_code,
                "activated_at": lic["issued_at"] or now,
                "bound_at": now,
                "last_verified_at": now,
                "last_attempt_at": now,
                "last_error": "",
                "lock_reason": "",
            })
            self._save()
        # 批量预生成的码签名不绑机器，激活时报到一次让授权服务认领这台设备；
        # 写死机器码的码本地已经判过，不必为它多等一趟网络往返（离线买家常常连不上 Worker）
        if base and not lic["machine"]:
            report = self._report_offline(base, text)
            if not report.get("ok") and report.get("reason") in ("revoked", "device_mismatch"):
                return {"ok": False, "reason": report["reason"],
                        "error": report.get("error") or "该授权码不可用", "status": self.status()}
        return {"ok": True, "message": "离线授权已激活", "status": self.status()}

    def activate_any(self, raw_code: str, server_url: Optional[str] = None) -> Dict[str, Any]:
        """激活入口：按前缀区分在线卡密（KAY-）与离线授权码（KAYO-）。"""
        if normalize_offline_code(raw_code):
            return self.activate_offline(raw_code, server_url=server_url)
        return self.activate(raw_code, server_url=server_url)

    def _apply_lock(self, reason: str, message: str) -> None:
        notify = False
        with self.lock:
            self._state["lock_reason"] = reason
            self._state["last_error"] = message
            self._save()
            if self._lock_notified != reason:
                self._lock_notified = reason
                notify = True
        if notify and self.on_locked:
            try:
                self.on_locked(reason, message)
            except Exception as exc:  # pragma: no cover - 回调不能影响校验线程
                print("[!] 授权锁定回调失败：%s" % exc, file=sys.stderr)

    def verify_now(self, force: bool = False) -> Dict[str, Any]:
        with self.lock:
            if self._verifying:
                return {"ok": False, "reason": "busy", "error": "正在校验中"}
            code = self._state.get("code") or ""
            offline = self._state.get("offline_code") or ""
            mode = "offline" if offline and not code else "online"
            if not code and not offline:
                return {"ok": False, "reason": "not_activated", "error": "面板尚未激活"}
            if not force and time.time() - int(self._state.get("last_attempt_at") or 0) < 60:
                return {"ok": False, "reason": "throttled", "error": "刚刚已尝试过校验，请稍后再试"}
            self._verifying = True
            base = self.server_url()
            self._state["last_attempt_at"] = int(time.time())
            self._save()

        if mode == "offline":
            try:
                return self._report_offline(base, offline)
            finally:
                with self.lock:
                    self._verifying = False

        try:
            data = self._post("/verify", {"code": code, "machine_code": self.machine_code}, base_url=base)
        except LicenseError as exc:
            with self.lock:
                self._state["last_error"] = exc.message
                self._verifying = False
            if exc.reason in LOCK_REASONS:
                self._apply_lock(exc.reason, exc.message)
                return {"ok": False, "reason": exc.reason, "error": exc.message, "status": self.status()}
            with self.lock:
                self._save()
            return {"ok": False, "reason": exc.reason, "error": exc.message, "status": self.status()}

        lic = data.get("license") or {}
        now = int(time.time())
        with self.lock:
            self._state.update({
                "last_verified_at": int(data.get("verified_at") or now),
                "activated_at": int(lic.get("activated_at") or self._state.get("activated_at") or now),
                "bound_at": int(lic.get("bound_at") or self._state.get("bound_at") or now),
                "last_error": "",
                "lock_reason": "",
            })
            self._verifying = False
            self._lock_notified = ""
            self._save()
        return {"ok": True, "message": "校验通过", "status": self.status()}

    def _report_offline(self, base: str, offline_code: str) -> Dict[str, Any]:
        """离线授权的联网部分：本地验签保证自身有效，再向授权服务报到问一次是否被吊销。
        报到失败不影响使用，这正是离线授权的意义。"""
        now = int(time.time())
        with self.lock:
            reference = max(now, int(self._state.get("max_seen_at") or 0))
        result = verify_offline_license(offline_code, self.machine_code, now=reference)
        if not result["ok"]:
            self._apply_lock(result["reason"] if result["reason"] in LOCK_REASONS else "tampered",
                             result["error"])
            return {"ok": False, "reason": result["reason"], "error": result["error"],
                    "status": self.status()}

        if not base:
            with self.lock:
                self._state["last_error"] = ""
                self._verifying = False
                self._save()
            return {"ok": True, "reported": False, "message": "离线授权有效（未配置授权服务，不上报）",
                    "status": self.status()}

        try:
            data = self._post("/offline/report", {
                "serial": result["license"]["serial"],
                "machine_code": self.machine_code,
                "product": "kay-cftunnle",
            }, base_url=base)
        except LicenseError as exc:
            with self.lock:
                self._state["last_error"] = "报到未成功（不影响使用）：%s" % exc.message
                self._verifying = False
                self._save()
            return {"ok": True, "reported": False, "reason": exc.reason,
                    "message": "离线授权有效，暂未能连接授权服务", "status": self.status()}

        self._verifying = False
        if data.get("revoked"):
            message = str(data.get("error") or "离线授权已被吊销")
            self._apply_lock("revoked", message)
            return {"ok": False, "reason": "revoked", "error": message, "status": self.status()}
        if data.get("device_mismatch"):
            message = str(data.get("error") or "该授权码已绑定其他设备")
            self._apply_lock("device_mismatch", message)
            return {"ok": False, "reason": "device_mismatch", "error": message, "status": self.status()}
        with self.lock:
            self._state.update({
                "last_verified_at": int(data.get("reported_at") or now),
                "last_error": "",
                "lock_reason": "",
            })
            self._lock_notified = ""
            self._save()
        return {"ok": True, "reported": True, "message": "校验通过", "status": self.status()}

    # ------------------------------------------------------------ 后台校验

    def start_background(self, initial_delay: int = 20) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, args=(initial_delay,), name="license-verify", daemon=True)
        self._thread.start()

    def stop_background(self) -> None:
        self._stop.set()

    def _loop(self, initial_delay: int) -> None:
        if self._stop.wait(max(1, initial_delay)):
            return
        while not self._stop.is_set():
            try:
                with self.lock:
                    code = self._state.get("code") or ""
                    offline = self._state.get("offline_code") or ""
                    locked = self._state.get("lock_reason") or ""
                    last_verified = int(self._state.get("last_verified_at") or 0)
                    last_attempt = int(self._state.get("last_attempt_at") or 0)
                now = time.time()
                if (code or offline) and not locked:
                    due = (not last_verified) or (now - last_verified >= self.verify_interval)
                    cooled = now - last_attempt >= DEFAULT_RETRY_INTERVAL
                    if due and cooled:
                        self.verify_now(force=True)
            except Exception as exc:  # pragma: no cover - 后台线程兜底
                print("[!] 授权后台校验异常：%s" % exc, file=sys.stderr)
            if self._stop.wait(300):
                break
