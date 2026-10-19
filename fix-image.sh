#!/bin/bash
# =============================================================================
# Kay-cftunnle · NAS 一键就绪（自动找镜像 / 自动改名 / 必要时构建）
#
# 这个脚本解决的是「明明有镜像，但飞牛找不到」的问题：
#   飞牛 fpk 要求镜像名精确等于 kaycftunnle:latest，
#   而 NAS 上的镜像可能叫 kay-cftunnle:latest、cftun-panel-kay-cftunnle:latest 等。
#   本脚本会自动找出所有 kay 相关镜像，能改名就改名（秒完成），
#   实在没有才去构建（几分钟）。
#
# 用法（NAS 终端）：
#   sh fix-image.sh            # 自动处理（推荐）
#   sh fix-image.sh --list     # 只列出镜像，不改动
#   sh fix-image.sh --build    # 强制重新构建
#
# 需要 sudo：sudo sh fix-image.sh
# =============================================================================
set -u

TARGET="kaycftunnle:latest"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

ok()   { printf '\033[32m[✓]\033[0m %s\n' "$*"; }
info() { printf '\033[32m[*]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[x]\033[0m %s\n' "$*"; }
hr()   { printf '%s\n' "------------------------------------------------------------"; }

MODE="auto"
for a in "$@"; do
  case "$a" in
    --list)  MODE="list" ;;
    --build) MODE="build" ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) err "未知参数: $a"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------- 前置
hr
info "目标镜像名：$TARGET"

if ! command -v docker >/dev/null 2>&1; then
  err "找不到 docker 命令。请用 sudo 执行，或确认飞牛已启用 Docker。"
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  err "无法连接 Docker 守护进程。请用 sudo 重新执行："
  err "    sudo sh $0"
  exit 1
fi
ok "Docker 可用"

# ---------------------------------------------------------------- 列出候选
# 只取 Repository:Tag，排除 <none>:<none>
CANDIDATES=$(docker image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
             | grep -v '<none>' | sort -u)

info "NAS 上所有以 kay 开头的镜像："
KAY_IMAGES=$(echo "$CANDIDATES" | grep -i 'kay')
if [ -n "$KAY_IMAGES" ]; then
  echo "$KAY_IMAGES" | sed 's/^/    /'
else
  echo "    （无）"
fi
hr

if [ "$MODE" = "list" ]; then
  echo "以上为全部候选。去掉 --list 可自动处理。"
  exit 0
fi

# ---------------------------------------------------------------- 目标已存在
if docker image inspect "$TARGET" >/dev/null 2>&1; then
  ok "$TARGET 已存在，无需任何操作"
  echo
  info "现在可以去飞牛应用中心安装 kaycftunnle-1.0.0.fpk 了"
  exit 0
fi

# ---------------------------------------------------------------- 尝试改名复用
if [ "$MODE" != "build" ]; then
  info "$TARGET 不存在，尝试从已有镜像改名复用…"

  # 优先级：名字里同时含 kay 和 cftun 的最优先，其次是含 kay 的
  PICK=""
  for pat in 'kay.*cftun' 'cftun.*kay' 'kay'; do
    FOUND=$(echo "$KAY_IMAGES" | grep -iE "$pat" | head -1)
    if [ -n "$FOUND" ]; then
      PICK="$FOUND"
      break
    fi
  done

  # 名字里没有 kay 但可能是这个项目的（compose 自动命名的镜像）
  if [ -z "$PICK" ]; then
    PICK=$(echo "$CANDIDATES" | grep -iE 'cftun|tunnel.*panel' | head -1)
  fi

  if [ -n "$PICK" ]; then
    info "选中：$PICK"
    if docker tag "$PICK" "$TARGET"; then
      ok "已改名为 $TARGET（原镜像保留，不影响原有部署）"
      echo
      info "现在可以去飞牛应用中心安装 kaycftunnle-1.0.0.fpk 了"
      exit 0
    else
      err "改名失败，改用构建方式"
    fi
  else
    warn "没有可复用的镜像，转为构建"
  fi
fi

# ---------------------------------------------------------------- 构建
info "开始构建 $TARGET"

if [ ! -f "$SCRIPT_DIR/Dockerfile" ]; then
  err "当前目录没有 Dockerfile：$SCRIPT_DIR"
  err "请把本脚本放到项目根目录再执行，或用  --list  看看现有镜像。"
  exit 1
fi
if [ ! -f "$SCRIPT_DIR/server.py" ]; then
  err "当前目录缺少 server.py，源码不完整。"
  exit 1
fi

hr
docker build -t "$TARGET" "$SCRIPT_DIR"
RC=$?
hr

if [ $RC -ne 0 ]; then
  err "构建失败。常见原因与对策："
  err "  1) 拉取基础镜像超时 → 换国内源重试："
  err "       docker build \\"
  err "         --build-arg PY_BASE_IMAGE=docker.m.daocloud.io/library/python:3.13-slim \\"
  err "         --build-arg CF_IMAGE=docker.m.daocloud.io/cloudflare/cloudflared:latest \\"
  err "         -t $TARGET ."
  err "  2) 磁盘不足 → docker system df 查看，docker image prune -a 清理"
  err "  3) 上面的日志里有具体报错行"
  exit 1
fi

if docker image inspect "$TARGET" >/dev/null 2>&1; then
  ok "构建成功：$TARGET"
  echo
  info "现在可以去飞牛应用中心安装 kaycftunnle-1.0.0.fpk 了"
else
  err "构建结束但找不到镜像，请检查上面日志"
  exit 1
fi
