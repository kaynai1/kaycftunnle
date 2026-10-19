#!/bin/bash
# 一步到位：本机有 docker 就构建镜像 + 打包成自包含 fpk
# 用法：sh packaging/fnos/build-offline.sh
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
IMAGE="kaycftunnle:latest"
TAR="$PROJECT_DIR/dist/kaycftunnle.tar"

info() { printf '\033[32m[*]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[x]\033[0m %s\n' "$*" >&2; }

if ! command -v docker >/dev/null 2>&1; then
  err "未检测到 docker。本脚本需要一台装有 Docker 的机器来构建镜像。"
  err "没有 Docker 也行：在 NAS 上  docker load -i 镜像.tar  后，"
  err "用  sh packaging/fnos/build-fpk.sh --no-embed  生成轻量包。"
  exit 1
fi

info "构建镜像 $IMAGE"
docker build -t "$IMAGE" "$PROJECT_DIR"

info "导出镜像到 dist/（这是给 NAS 手工导入用的，可选）"
mkdir -p "$PROJECT_DIR/dist"
docker save "$IMAGE" -o "$TAR"

info "打包 fpk"
sh "$SCRIPT_DIR/build-fpk.sh"

info "全部完成，产物在 $PROJECT_DIR/dist/"
ls -lh "$PROJECT_DIR/dist/"
