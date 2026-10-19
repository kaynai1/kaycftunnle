#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 EasonShu
# =========================================================================
# Kay-cftunnle 面板 · systemd 部署脚本（不用 Docker 的路线，二选一）
#
# 用法（在源码根目录里执行）：
#     sudo sh deploy/install.sh
#
# 可用环境变量覆盖默认值：
#     APP_DIR=/opt/kay-cftunnle   安装目录
#     APP_USER=cfrun             运行用户
#     PY=/usr/bin/python3        解释器路径
#
# 重复执行是安全的：配置(data/workbench.json)、数据库(data/kay-cftunnle.sqlite3)、
# 运行期数据(runtime/) 都会被保留，只更新代码。
# =========================================================================
set -eu

APP_NAME=kay-cftunnle
APP_DIR=${APP_DIR:-/opt/kay-cftunnle}
APP_USER=${APP_USER:-cfrun}
PY=${PY:-/usr/bin/python3}
PORT=${DASHBOARD_PORT:-8000}
SERVICE=/etc/systemd/system/${APP_NAME}.service

info() { echo "[*] $*"; }
warn() { echo "[!] $*" >&2; }
die()  { echo "[x] $*" >&2; exit 1; }

# ---------------------------------------------------------------- 前置检查
[ "$(id -u)" = "0" ] || die "需要 root 权限，请用 sudo 运行"

command -v systemctl >/dev/null 2>&1 || die "没有 systemctl，本脚本只支持 systemd 发行版"

[ -x "$PY" ] || die "找不到解释器 $PY（可用 PY=/usr/bin/python3.11 指定）"

PYVER=$("$PY" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
case "$PYVER" in
  3.8|3.9|3.10|3.11|3.12|3.13|3.14) : ;;
  *) die "Python 版本为 $PYVER，需要 3.8 以上" ;;
esac
info "Python $PYVER"

# ---------------------------------------------------------------- 安装 cloudflared
info "安装/更新 cloudflared"
ARCH=""
case "$(uname -m)" in
  x86_64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) die "不支持的架构: $(uname -m)" ;;
esac

CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}"
CF_MIRROR="https://mirror.ghproxy.com/https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}"
CF_BIN="/usr/local/bin/cloudflared"

info "下载 cloudflared (${ARCH})..."
if curl -fsSL --retry 2 --connect-timeout 15 "$CF_URL" -o "$CF_BIN" 2>/dev/null; then
  :
elif curl -fsSL --retry 2 --connect-timeout 15 "$CF_MIRROR" -o "$CF_BIN" 2>/dev/null; then
  info "已使用国内镜像下载 cloudflared"
else
  die "无法下载 cloudflared，请检查网络"
fi
chmod +x "$CF_BIN"
info "cloudflared 版本: $("$CF_BIN" --version)"

# 源码根目录 = 本脚本所在目录的上一级
SRC=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$SRC/server.py" ] || die "在 $SRC 里找不到 server.py，请确认从源码根目录运行"

if [ "$SRC" = "$APP_DIR" ]; then
  die "源码目录与安装目录相同（$SRC），请把源码放到别处再执行"
fi

# ---------------------------------------------------------------- 运行用户
if ! id "$APP_USER" >/dev/null 2>&1; then
  info "创建系统用户 $APP_USER"
  if command -v useradd >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER" 2>/dev/null \
      || useradd -r -s /sbin/nologin "$APP_USER"
  else
    adduser --system --no-create-home --disabled-login "$APP_USER"
  fi
fi

# ------------------------------------------------- 保护运行期数据（重要）
# 这些是"服务器上攒出来的"，重新部署不能冲掉：全局配置（含会话密钥与
# Cloudflare 凭据）、用户库、连接器运行期数据。
KEEP_BACKUP=$(mktemp -d)
trap 'rm -rf "$KEEP_BACKUP"' EXIT INT TERM

KEEP_LIST="data/workbench.json data/kay-cftunnle.sqlite3 data/kay-cftunnle.sqlite3-wal data/kay-cftunnle.sqlite3-shm runtime"
for rel in $KEEP_LIST; do
  if [ -e "$APP_DIR/$rel" ]; then
    mkdir -p "$KEEP_BACKUP/$(dirname "$rel")"
    cp -R "$APP_DIR/$rel" "$KEEP_BACKUP/$rel" 2>/dev/null || true
  fi
done

# ---------------------------------------------------------------- 同步代码
info "安装到 $APP_DIR"
mkdir -p "$APP_DIR"
cp -R "$SRC/." "$APP_DIR/"

# 还原被保护的数据
for rel in $KEEP_LIST; do
  if [ -e "$KEEP_BACKUP/$rel" ]; then
    rm -rf "$APP_DIR/$rel"
    mkdir -p "$APP_DIR/$(dirname "$rel")"
    cp -R "$KEEP_BACKUP/$rel" "$APP_DIR/$rel"
    info "保留原有 $rel"
  fi
done

# 首次安装（服务器上原本没有配置）时，别把源码目录里附带的开发配置带过去
if [ ! -e "$KEEP_BACKUP/data/workbench.json" ]; then
  info "首次安装：首次启动会按默认配置播种管理员 admin / 123456"
fi

# 清理编译产物，别让不同机器的 .pyc 混进去
find "$APP_DIR" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 700 "$APP_DIR/data" "$APP_DIR/runtime" 2>/dev/null || true

# ---------------------------------------------------------------- systemd
info "安装 systemd 单元 → $SERVICE"
sed -e "s#/opt/kay-cftunnle#$APP_DIR#g" \
    -e "s#^User=.*#User=$APP_USER#" \
    -e "s#^Group=.*#Group=$APP_USER#" \
    -e "s#^ExecStart=.*#ExecStart=$PY $APP_DIR/server.py#" \
    "$SRC/deploy/${APP_NAME}.service" > "$SERVICE"
chmod 644 "$SERVICE"

systemctl daemon-reload
systemctl enable "$APP_NAME" >/dev/null 2>&1 || true
systemctl restart "$APP_NAME"

sleep 2
if systemctl is-active --quiet "$APP_NAME"; then
  info "服务已启动"
else
  warn "服务未能启动，看日志：journalctl -u $APP_NAME -n 50 --no-pager"
fi

# ---------------------------------------------------------------- 收尾提示
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "${IP:-}" ] || IP="<服务器IP>"

echo
echo "================================================================"
echo " Kay-cftunnle 面板已部署"
echo "   安装目录 : $APP_DIR"
echo "   运行用户 : $APP_USER"
echo "   访问地址 : http://$IP:$PORT"
echo "   登录方式 : 无密码模式，浏览器打开即可直接使用"
echo
echo " 下一步："
echo "   1. 浏览器打开面板，进入「设置」页填入 Cloudflare API Token"
echo "   2. 连接器 / 系统设置中选择连接协议（HTTP/2 或 QUIC）并保存"
echo "   3. 放行端口：firewall-cmd --add-port=$PORT/tcp --permanent && firewall-cmd --reload"
echo "      （或 ufw allow $PORT / 飞牛防火墙）"
echo "   3. 看日志：journalctl -u $APP_NAME -f"
echo "================================================================"
