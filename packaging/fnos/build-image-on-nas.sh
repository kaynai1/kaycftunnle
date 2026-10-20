#!/bin/bash
# =============================================================================
# Kay-cftunnle · NAS 端一键构建镜像并打包 fpk
#
# 用法：
#   sudo sh packaging/fnos/build-image-on-nas.sh
#
# 作用：
#   1. 在 NAS 上用 docker build 构建 kaycftunnle:latest 镜像
#   2. docker save 导出镜像
#   3. 调用 fnpack（自动下载 Linux 版）打包成内嵌镜像的 fpk
#   4. 产物：dist/kaycftunnle-<版本>.fpk（约 200-300 MB）
#
# 依赖：NAS 上已安装 Docker，且有 curl + tar
# =============================================================================
set -eu

PROJECT_DIR=$(cd "$(dirname "$0")/../../" && pwd)
SCRIPT_DIR="$PROJECT_DIR/packaging/fnos"
IMAGE_NAME="kaycftunnle:latest"
TAR_FILE="$PROJECT_DIR/kaycftunnle.tar"

info() { printf '\033[32m[*]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[32m[✓]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[x]\033[0m %s\n' "$*" >&2; }

# ---------------------------------------------------------------- 检查 Docker
if ! command -v docker >/dev/null 2>&1; then
  err "未检测到 docker 命令。请在飞牛应用中心安装 Docker 后再试。"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  err "Docker 守护进程未运行或无权限。尝试：sudo sh $0"
  exit 1
fi

info "项目目录: $PROJECT_DIR"
info "目标镜像: $IMAGE_NAME"

# ---------------------------------------------------------------- 构建镜像
cd "$PROJECT_DIR"

if docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
  warn "镜像 $IMAGE_NAME 已存在，跳过构建"
else
  info "开始构建 $IMAGE_NAME ..."
  docker build -t "$IMAGE_NAME" "$PROJECT_DIR" || {
    err "镜像构建失败。如果卡在拉基础镜像，可换国内源重试："
    err "  docker build --build-arg PY_BASE_IMAGE=docker.m.daocloud.io/library/python:3.13-slim --build-arg CF_IMAGE=docker.m.daocloud.io/cloudflare/cloudflared:latest -t $IMAGE_NAME ."
    exit 1
  }
fi

# ---------------------------------------------------------------- 导出镜像
info "导出镜像到 $TAR_FILE（可能需要几分钟）..."
docker save "$IMAGE_NAME" -o "$TAR_FILE" || { err "docker save 失败"; exit 1; }

SIZE=$(du -h "$TAR_FILE" | cut -f1)
ok "镜像已导出: $TAR_FILE ($SIZE)"

# ---------------------------------------------------------------- 打包 fpk
info "开始打包成自包含 fpk（内嵌镜像，点开即用）..."
sh "$SCRIPT_DIR/build-fpk.sh" --tar "$TAR_FILE" || {
  err "fpk 打包失败，请查看上面的日志"
  exit 1
}

# ---------------------------------------------------------------- 完成
VERSION=$(grep -E '^version' "$SCRIPT_DIR/manifest" | head -1 | cut -d= -f2 | xargs)
FPK="$PROJECT_DIR/dist/kaycftunnle-$VERSION.fpk"
if [ -f "$FPK" ]; then
  FPK_SIZE=$(du -h "$FPK" | cut -f1)
  ok "打包完成: $FPK ($FPK_SIZE)"
  cat <<EOF

================================================================================
恭喜，自包含 fpk 已生成！
================================================================================

文件位置：
  $FPK

体积约 ${FPK_SIZE}，已内嵌镜像，装到飞牛上：
  - 不需要 NAS 上先有镜像
  - 不需要联网拉取
  - 安装后自动 docker load
  - 点开直接用

下一步：
  1. 把这个 .fpk 文件下载到电脑
  2. 飞牛桌面 → 应用中心 → 右上角「手动安装」
  3. 选择 $FPK
  4. 等待安装完成，桌面出现 Kay-cftunnle 图标

================================================================================
EOF
else
  err "未找到生成的 fpk"
  exit 1
fi
