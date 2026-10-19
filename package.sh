#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 EasonShu
# =====================================================================
# Kay-cftunnle 面板 · 飞牛 NAS 部署包打包脚本
#
# 用法：
#   sh package.sh                    # 生成 dist/Kay-cftunnle面板-飞牛NAS部署包.zip
#   sh package.sh <输出目录>          # 指定输出目录
#
# 产物可直接上传到 NAS，执行：
#   sh deploy-kay-cftunnle.sh
# =====================================================================
set -eu

OUT_DIR="${1:-dist}"
APP_NAME="Kay-cftunnle面板-飞牛NAS部署包"
VERSION=$(git describe --tags --always 2>/dev/null || date +%Y%m%d)
ZIP_NAME="${APP_NAME}-${VERSION}.zip"

info() { echo "[*] $*"; }
die()  { echo "[x] $*" >&2; exit 1; }

info "版本: $VERSION"
info "输出: $OUT_DIR/$ZIP_NAME"

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/$ZIP_NAME"

# 打包文件清单（排除开发期数据、缓存、git）
zip -r "$OUT_DIR/$ZIP_NAME" \
  server.py \
  cf.py \
  static/ \
  deploy/ \
  Dockerfile \
  docker-compose.yml \
  deploy-kay-cftunnle.sh \
  build.sh \
  package.sh \
  README.md \
  -x "*.pyc" -x "*.pyo" -x "__pycache__/*" -x "*.log" \
  -x ".git/*" -x "data/*" -x "runtime/*" -x ".github/*"

info "打包完成: $OUT_DIR/$ZIP_NAME"
info "大小: $(du -h "$OUT_DIR/$ZIP_NAME" | cut -f1)"
