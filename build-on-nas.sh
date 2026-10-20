#!/bin/bash
# =============================================================================
# Kay-cftunnle · 在 NAS 上直接构建镜像
#
# 用途：飞牛应用中心的 fpk 安装阶段会直接 docker compose up，镜像不在本地就报
#       "No such image: kaycftunnle:latest"，因此必须【先构建镜像，再装包】。
#
# 用法（在 NAS 终端、项目根目录执行）：
#   sudo sh build-on-nas.sh              # 标准构建
#   sudo sh build-on-nas.sh --retag kaycftunnle:latest   # 已有旧镜像，直接改名复用
#   sudo sh build-on-nas.sh --check      # 只检查现状，不构建
#
# 完成后回飞牛应用中心安装 kaycftunnle-1.0.0.fpk 即可
# =============================================================================
set -u

IMAGE="kaycftunnle:latest"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR="$SCRIPT_DIR"

ok()   { printf '\033[32m[✓]\033[0m %s\n' "$*"; }
info() { printf '\033[32m[*]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[x]\033[0m %s\n' "$*"; }
die()  { err "$*"; exit 1; }

has_image() { docker image inspect "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- 参数
RETAG_FROM=""
CHECK_ONLY="no"
while [ $# -gt 0 ]; do
  case "$1" in
    --retag) RETAG_FROM="$2"; shift 2 ;;
    --check) CHECK_ONLY="yes"; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) die "未知参数: $1" ;;
  esac
done

# ---------------------------------------------------------------- 前置检查
command -v docker >/dev/null 2>&1 || die "未找到 docker，请确认飞牛已启用 Docker 且当前用户可执行。"

info "目标镜像: $IMAGE"

if [ "$CHECK_ONLY" = "yes" ]; then
  if has_image "$IMAGE"; then
    ok "$IMAGE 已存在，可以直接安装 fpk 了"
  else
    warn "$IMAGE 不存在，需要先构建"
    info "当前本地所有相关镜像："
    docker image ls | grep -i kay || echo "  （无）"
  fi
  exit 0
fi

# 已经存在就不重复构建
if has_image "$IMAGE"; then
  ok "$IMAGE 已存在，无需重复构建"
  info "如果你想强制重建，先执行：docker rmi $IMAGE"
  exit 0
fi

# ---------------------------------------------------------------- 旧镜像改名复用
if [ -n "$RETAG_FROM" ]; then
  if ! has_image "$RETAG_FROM"; then
    err "找不到镜像 $RETAG_FROM"
    info "当前本地所有相关镜像（挑一个正确的名字重跑 --retag）："
    docker image ls | grep -i kay || echo "  （无）"
    exit 1
  fi
  info "把 $RETAG_FROM 改名为 $IMAGE"
  docker tag "$RETAG_FROM" "$IMAGE" || die "docker tag 失败"
  if has_image "$IMAGE"; then
    ok "完成，现在可以去应用中心安装 kaycftunnle-1.0.0.fpk 了"
  else
    die "改名后仍找不到镜像，请执行  docker image ls | grep kay  检查实际名字"
  fi
  exit 0
fi

# ---------------------------------------------------------------- 检查源码
[ -f "$PROJECT_DIR/Dockerfile" ] || die "当前目录没有 Dockerfile，请在项目根目录执行本脚本"
[ -f "$PROJECT_DIR/server.py" ]  || die "当前目录缺少 server.py，请确认源码完整"

# ---------------------------------------------------------------- 构建
info "开始构建（首次会拉取 python:3.13-slim 与 cloudflared，约需 3-10 分钟）"
echo "------------------------------------------------------------------"

if ! docker build -t "$IMAGE" "$PROJECT_DIR"; then
  echo "------------------------------------------------------------------"
  err "构建失败。常见原因："
  err "  1) 拉取 python:3.13-slim / cloudflare/cloudflared 超时"
  err "     → 换国内源重试："
  err "       docker build \\"
  err "         --build-arg PY_BASE_IMAGE=docker.m.daocloud.io/library/python:3.13-slim \\"
  err "         --build-arg CF_IMAGE=docker.m.daocloud.io/cloudflare/cloudflared:latest \\"
  err "         -t $IMAGE ."
  err "  2) 磁盘空间不足 → docker system df 查看，docker system prune -a 清理"
  err "  3) Dockerfile 里的语法/断言失败 → 上面日志会提示具体哪一行"
  exit 1
fi

echo "------------------------------------------------------------------"

# ---------------------------------------------------------------- 验证
if has_image "$IMAGE"; then
  SIZE=$(docker image inspect "$IMAGE" -f '{{.Size}}' 2>/dev/null | awk '{printf "%.1f MB", $1/1024/1024}')
  ok "构建成功：$IMAGE（约 ${SIZE:-未知}）"
  echo
  info "自检：容器内直接请求 /api/health（不占宿主机端口，不依赖 curl）"
  # --add-host 让容器内能解析 127.0.0.1；--rm 用完即删
  if docker run --rm "$IMAGE" python -c "
import json, sys, time, urllib.request
for i in range(20):
    try:
        with urllib.request.urlopen('http://127.0.0.1:8567/api/health', timeout=2) as r:
            d = json.loads(r.read().decode())
            print('health ->', d)
            sys.exit(0 if d.get('ok') else 1)
    except Exception as e:
        time.sleep(1)
print('健康检查超时', file=sys.stderr)
sys.exit(1)
" 2>&1 | sed 's/^/    /'; then
    ok "自检通过，服务能正常启动并响应"
  else
    warn "自检未通过，但镜像已构建成功（可能只是首次启动较慢）"
    warn "装好后若打不开，用  docker logs kaycftunnle --tail 50  查看"
  fi
  echo
  ok "现在可以去飞牛应用中心安装 kaycftunnle-1.0.0.fpk 了"
else
  die "构建结束但找不到镜像，请检查上面的日志"
fi
