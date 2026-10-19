#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 EasonShu
# =====================================================================
# Kay-cftunnle 面板 · 本地多架构 Docker 构建脚本
#
# 用法：
#   sh build.sh                              # 构建默认镜像名 kaycftunnle:latest
#   sh build.sh <镜像名:标签>                 # 指定镜像名与标签
#   REGISTRY=ghcr.io/username sh build.sh    # 指定仓库前缀
#
# 前置要求：Docker 已启用 buildx，且能访问 Docker Hub / GitHub Container Registry
# =====================================================================
set -eu

IMAGE_NAME="${1:-kaycftunnle:latest}"
REGISTRY="${REGISTRY:-}"
if [ -n "$REGISTRY" ]; then
  IMAGE_NAME="${REGISTRY%/}/${IMAGE_NAME}"
fi

info() { echo "[*] $*"; }
die()  { echo "[x] $*" >&2; exit 1; }

# 检查 docker / buildx
command -v docker >/dev/null 2>&1 || die "未找到 docker 命令"
docker buildx version >/dev/null 2>&1 || die "Docker buildx 未启用，请执行：docker buildx create --use"

info "构建镜像: $IMAGE_NAME（linux/amd64, linux/arm64）"
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag "$IMAGE_NAME" \
  --push \
  .

info "构建完成: $IMAGE_NAME"
