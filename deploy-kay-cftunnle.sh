#!/bin/sh
# =============================================================================
# Kay-cftunnle 面板 · 飞牛 NAS 一键部署脚本（Docker）
#
# 三种用法，任选其一：
#   A) 上传 zip 后直接跑（推荐）：
#        sh deploy-kay-cftunnle.sh /实际路径/Kay-cftunnle面板-飞牛NAS部署包.zip
#   B) 已经解压好、当前就在源码目录里：
#        sh deploy-kay-cftunnle.sh
#   C) 不传参数，让脚本自动找 zip（会搜当前目录/家目录/常见卷）：
#        sh deploy-kay-cftunnle.sh
#
# 脚本流程：Docker 探测 → 环境自检 → 定位/解压 → 安装 → 构建启动 → 自检验证
# =============================================================================
set -eu

# ---------------------------------------------------------------- 可调参数
APP_DIR="${APP_DIR:-/vol1/1000/qd/kay-cftunnle}"   # 安装目录（数据落在这里）
PORT="${PORT:-8567}"                              # 对外端口
CONTAINER="kay-cftunnle"
ZIP_HINT="${1:-}"                                 # 部署包路径（可选）

# ---------------------------------------------------------------- 输出函数
info() { printf '\033[32m[*]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31m[x]\033[0m %s\n' "$*" >&2; }
step() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- 0. Docker 权限
step "0/6 探测 Docker 权限"
DOCKER=""
if docker info >/dev/null 2>&1; then
  DOCKER="docker"
elif command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
  DOCKER="sudo docker"
fi
if [ -z "$DOCKER" ]; then
  err "无法使用 Docker。请确认：① 飞牛「应用中心」已安装并启动 Docker；② 当前用户有 docker 权限或可用 sudo。"
  exit 1
fi
info "Docker 可用：$DOCKER"

COMPOSE=""
if $DOCKER compose version >/dev/null 2>&1; then
  COMPOSE="$DOCKER compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
elif [ "$DOCKER" = "sudo docker" ] && sudo docker-compose version >/dev/null 2>&1; then
  COMPOSE="sudo docker-compose"
fi
if [ -z "$COMPOSE" ]; then
  err "未找到 docker compose。请在飞牛 Docker 应用里确认 compose 已安装。"
  exit 1
fi
info "Compose 可用：$COMPOSE"

# ---------------------------------------------------------------- 1. 环境自检
step "1/6 环境自检"
command -v python3 >/dev/null 2>&1 && info "系统 python3：$(python3 --version 2>&1)" || warn "无 python3（不影响，容器内自带）"

if command -v ss >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | grep -q ":${PORT}[[:space:]]"; then
    warn "端口 ${PORT} 已被占用！可改脚本顶部 PORT= 换端口。"
    printf '是否继续？(y/N) '
    read -r answer </dev/tty 2>/dev/null || answer="n"
    case "$answer" in y|Y) info "继续…" ;; *) err "已取消。"; exit 1 ;; esac
  else
    info "端口 ${PORT} 空闲"
  fi
fi

AVAIL=$(df -m "$(dirname "$APP_DIR" 2>/dev/null || echo /tmp)" 2>/dev/null | awk 'NR==2{print $4}')
[ -n "${AVAIL:-}" ] && [ "$AVAIL" -lt 500 ] 2>/dev/null && warn "目标分区剩余 ${AVAIL}MB，建议≥500MB。" || info "磁盘空间（剩余 ${AVAIL:-未知}MB）"

# ---------------------------------------------------------------- 2. 定位源码
step "2/6 定位部署包/源码"
SRC=""
TMP_EXTRACT=""

# B) 当前目录就是源码目录
if [ -f "./server.py" ] && [ -f "./docker-compose.yml" ]; then
  SRC="$(pwd)"
  info "检测到当前目录即源码目录：$SRC"
else
  # A/C) 找 zip 再解压
  ZIP=""
  if [ -n "$ZIP_HINT" ] && [ -f "$ZIP_HINT" ]; then
    ZIP="$ZIP_HINT"
  else
    for d in . "$HOME" /vol1/1000/qd /vol1/1000 /vol1 /vol2 /vol3 /volume1 /volume2 /tmp /mnt; do
      [ -d "$d" ] || continue
      found=$(find "$d" -maxdepth 3 \( -iname 'Kay-cftunnle*部署包*.zip' -o -iname 'Kay-cftunnle*.zip' -o -iname 'kay-cftunnle*.zip' \) 2>/dev/null | head -n1)
      if [ -n "$found" ]; then ZIP="$found"; break; fi
    done
  fi
  if [ -z "$ZIP" ] || [ ! -f "$ZIP" ]; then
    err "找不到部署包。请把 Kay-cftunnle面板-飞牛NAS部署包.zip 上传到 NAS，然后："
    err "    sh deploy-kay-cftunnle.sh /实际路径/Kay-cftunnle面板-飞牛NAS部署包.zip"
    err "或先解压、cd 进源码目录后直接：sh deploy-kay-cftunnle.sh"
    exit 1
  fi
  info "部署包：$ZIP"

  TMP_EXTRACT=$(mktemp -d)
  if command -v unzip >/dev/null 2>&1; then
    unzip -q -o "$ZIP" -d "$TMP_EXTRACT"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$ZIP" "$TMP_EXTRACT"
  else
    err "既无 unzip 也无 python3，无法解压。"
    exit 1
  fi
  SRC="$TMP_EXTRACT"
  if [ ! -f "$SRC/server.py" ]; then
    SRCPY=$(find "$TMP_EXTRACT" -maxdepth 3 -name server.py 2>/dev/null | head -n1)
    [ -n "$SRCPY" ] && SRC=$(dirname "$SRCPY")
  fi
  [ -f "$SRC/server.py" ] || { err "解压后找不到 server.py，包可能损坏。"; exit 1; }
  info "源码目录：$SRC"
fi

# ---------------------------------------------------------------- 3. 安装
step "3/6 安装到 $APP_DIR"
mkdir -p "$APP_DIR"

# 保留运行期配置（重要）：重复部署 / 升级时，绝不能把已生成的 data/workbench.json 冲掉。
# 它保存着 auth.secret（会话签名密钥）与 Cloudflare 凭据，一旦被覆盖重置：
#   ① auth.secret 变化 -> 所有已登录用户被强制退出；
#   ② 面板里填过的 API Token 被还原成默认值。
KEEP_CFG=""
if [ -f "$APP_DIR/data/workbench.json" ]; then
  KEEP_CFG=$(mktemp)
  cp "$APP_DIR/data/workbench.json" "$KEEP_CFG"
  info "检测到已有 data/workbench.json，稍后保留（不覆盖）"
fi

# 源码目录 == 安装目录时（就地升级），跳过复制，避免 cp 自身导致报错或递归。
SRC_REAL=$(cd "$SRC" && pwd)
APP_REAL=$(cd "$APP_DIR" && pwd)
if [ "$SRC_REAL" = "$APP_REAL" ]; then
  info "源码目录即安装目录，跳过文件复制（就地升级）"
else
  cp -R "$SRC/." "$APP_DIR/"
fi

if [ -n "$KEEP_CFG" ]; then
  mkdir -p "$APP_DIR/data"
  mv "$KEEP_CFG" "$APP_DIR/data/workbench.json"
  info "已保留原有 data/workbench.json（会话密钥与凭据不变）"
fi
mkdir -p "$APP_DIR/runtime"
info "代码已同步（data/ runtime/ 若已存在会保留）"

# ---------------------------------------------------------------- 4. 构建启动
step "4/6 构建并启动容器（首次构建需下载 cloudflared，国内网络约 1-3 分钟）"
cd "$APP_DIR"
# --force-recreate：只改代码不重建容器时，重启的仍是旧进程（旧接口/旧页面），必须强制重建
$COMPOSE up -d --build --force-recreate

# ---------------------------------------------------------------- 5. 自检
step "5/6 自检验证"
printf '等待服务就绪'
i=0
while [ $i -lt 30 ]; do
  printf '.'
  sleep 1
  i=$((i+1))
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/" 2>/dev/null || echo "000")
  [ "$code" = "200" ] && break
done
printf '\n'

echo
info "容器状态："
$COMPOSE ps || true

code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/" 2>/dev/null || echo "000")
echo
if [ "$code" = "200" ] || [ "$code" = "302" ]; then
  info "✅ HTTP 探测通过（返回 $code）"
else
  warn "⚠️ HTTP 探测返回 $code，可能仍在启动。查看日志："
  echo "    cd $APP_DIR && $COMPOSE logs --tail=50 $CONTAINER"
fi

echo
info "应用自检（python server.py --check）："
$DOCKER exec $CONTAINER python server.py --check 2>/dev/null | head -n 24 || \
  warn "（容器内自检未返回，可忽略；以 HTTP 探测为准）"

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "${IP:-}" ] || IP="<飞牛IP>"
echo
echo "=================================================================="
echo " Kay-cftunnle 面板部署完成"
echo "   安装目录 : $APP_DIR"
echo "   访问地址 : http://$IP:$PORT"
echo "   登录方式 : 无密码模式，浏览器打开即可直接使用"
echo "   开机自启 : Docker restart=unless-stopped，NAS 重启后自动启动"
echo
echo " 下一步："
echo "   1. 浏览器打开面板，进入「设置」页填入 Cloudflare API Token"
echo "      （权限：账户 Tunnel 编辑+读取 / 区域 DNS 编辑+读取 / 区域 读取）"
echo "   2. 进入「连接器」页，选择连接协议（HTTP/2 或 QUIC）并保存"
echo "   3. 飞牛「系统设置 → 防火墙」放行 ${PORT} 端口"
echo
echo " 常用命令："
echo "   查看日志 : cd $APP_DIR && $COMPOSE logs -f $CONTAINER"
echo "   重启     : cd $APP_DIR && $COMPOSE restart"
echo "   停止     : cd $APP_DIR && $COMPOSE down"
echo "   升级     : 重新执行本脚本"
echo "=================================================================="

[ -n "$TMP_EXTRACT" ] && rm -rf "$TMP_EXTRACT"
exit 0
