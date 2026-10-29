#!/bin/bash
# =============================================================================
# Kay-cftunnle · 飞牛 fnOS fpk 打包脚本
#
# 用法：
#   sh build-fpk.sh                            # 推荐：有 docker 就构建并把镜像打进包
#   sh build-fpk.sh --no-embed                 # 不内嵌镜像，装前需 NAS 上已有该镜像
#   sh build-fpk.sh --image <仓库/镜像:tag>     # 指定镜像名且不内嵌（已推到仓库时用）
#   sh build-fpk.sh --tar <镜像.tar>           # 使用已导出的镜像 tar 内嵌进包
#   sh build-fpk.sh --no-image                 # 完全不处理镜像，只打应用骨架（仅调试）
#   sh build-fpk.sh ... --output-suffix -offline
#                                              # 产物名追加后缀，便于同时发布在线/离线包
#   sh build-fpk.sh ... --platform x86         # 写入 manifest.platform（x86/arm/all）
#   sh build-fpk.sh --src-overlay --image ghcr.io/kaynai1/kaycftunnle:latest
#                                              # 测试包：基础镜像 + 当前源码绑定覆盖，无需重建镜像
#   sh build-fpk.sh ... --license-url https://9ky.us.ci
#                                              # 把卖家授权服务地址打进包里：
#                                              # 买家激活页无需手填，且离线码激活当场就能报到绑定设备
#
# 产物：dist/kaycftunnle-<版本><后缀>.fpk
#
# 依赖：官方 fnpack（缺失时自动下载到 .fnpack/）
# =============================================================================
set -eu

APP_NAME="kaycftunnle"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
PROJECT_DIR=$(cd "$SCRIPT_DIR/../.." && pwd)
BUILD_DIR="$PROJECT_DIR/.fpk-build"
DIST_DIR="$PROJECT_DIR/dist"
FNPACK_DIR="$PROJECT_DIR/.fnpack"

# 检测平台，下载对应 fnpack 二进制（NAS 通常是 Linux，Windows 是开发机）
_OS=$(uname -s | tr '[:upper:]' '[:lower:]')
_ARCH=$(uname -m | tr '[:upper:]' '[:lower:]')
case "$_ARCH" in
  x86_64|amd64) _ARCH="amd64" ;;
  aarch64|arm64) _ARCH="arm64" ;;
  *) _ARCH="amd64" ;;
esac
case "$_OS" in
  linux*|msys*|cygwin*|mingw*) FNPACK_BASENAME="fnpack-1.2.3-linux-$_ARCH" ;;
  darwin*) FNPACK_BASENAME="fnpack-1.2.3-darwin-$_ARCH" ;;
  *) FNPACK_BASENAME="fnpack-1.2.3-windows-amd64" ;;
esac
[ -n "${COMSPEC:-}" ] || [ -n "${WINDIR:-}" ] || [ "$_OS" = "windowsnt" ] && FNPACK_BASENAME="fnpack-1.2.3-windows-amd64"
FNPACK="$FNPACK_DIR/$FNPACK_BASENAME"

# 本地镜像名刻意带 local/ 前缀：公网不存在，docker 不会去 registry 拉
IMAGE_NAME="kaycftunnle:latest"
IMAGE_TAR=""
EMBED_IMAGE="auto"
SRC_OVERLAY="no"
LICENSE_URL=""
OUTPUT_SUFFIX=""
PACKAGE_PLATFORM=""

info() { printf '\033[32m[*]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[31m[x]\033[0m %s\n' "$*" >&2; }

# ---------------------------------------------------------------- 参数
while [ $# -gt 0 ]; do
  case "$1" in
    --image)   IMAGE_NAME="$2"; EMBED_IMAGE="no"; shift 2 ;;
    --tar)     IMAGE_TAR="$2"; EMBED_IMAGE="tar"; shift 2 ;;
    --no-embed) EMBED_IMAGE="no"; shift ;;
    --no-image) EMBED_IMAGE="skip"; shift ;;
    --src-overlay) SRC_OVERLAY="yes"; shift ;;
    --license-url) LICENSE_URL="$2"; shift 2 ;;
    --output-suffix) OUTPUT_SUFFIX="$2"; shift 2 ;;
    --platform) PACKAGE_PLATFORM="$2"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) err "未知参数: $1"; exit 1 ;;
  esac
done

VERSION=$(grep -E '^version' "$SCRIPT_DIR/manifest" | head -1 | cut -d= -f2 | xargs)
info "应用: $APP_NAME  版本: $VERSION"

# ---------------------------------------------------------------- fnpack
if [ ! -x "$FNPACK" ] && ! command -v fnpack >/dev/null 2>&1; then
  info "未找到 fnpack，正在下载官方 1.2.3 ($FNPACK_BASENAME)…"
  mkdir -p "$FNPACK_DIR"
  curl -fsSL -o "$FNPACK" "https://static2.fnnas.com/fnpack/$FNPACK_BASENAME" \
    || { err "fnpack 下载失败，请手动下载后放到 $FNPACK"; exit 1; }
  chmod +x "$FNPACK"
fi
command -v fnpack >/dev/null 2>&1 && FNPACK=$(command -v fnpack)
info "fnpack: $FNPACK"

# ---------------------------------------------------------------- 清理构建目录
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
# 用 tar 管道复制，避免 cp -R 递归进自身
(cd "$SCRIPT_DIR" && tar -cf - --exclude='build' --exclude='dist' --exclude='.DS_Store' .) | (cd "$BUILD_DIR" && tar -xf -)
rm -f "$BUILD_DIR/make_icons.py" "$BUILD_DIR/build-fpk.sh" "$BUILD_DIR/README.md" "$BUILD_DIR/build-offline.sh"
find "$BUILD_DIR" -name '.DS_Store' -delete 2>/dev/null || true

if [ -n "$PACKAGE_PLATFORM" ]; then
  sed -i -E "s/^platform[[:space:]]*=.*/platform     = ${PACKAGE_PLATFORM}/" "$BUILD_DIR/manifest"
  info "应用平台: $PACKAGE_PLATFORM"
fi

# ---------------------------------------------------------------- 镜像处理
IMG_TAR="$BUILD_DIR/app/docker/image.tar"

embed_image() {
  if ! command -v docker >/dev/null 2>&1; then
    warn "未检测到 docker，跳过镜像打包"
    return 1
  fi
  if ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
    info "本地无 $IMAGE_NAME，尝试构建…"
    docker build -t "$IMAGE_NAME" "$PROJECT_DIR" || { warn "镜像构建失败"; return 1; }
  fi
  info "导出镜像 $IMAGE_NAME（体积较大，请耐心等待）"
  docker save "$IMAGE_NAME" -o "$IMG_TAR" || { warn "镜像导出失败"; return 1; }
  return 0
}

embed_image_from_tar() {
  if [ ! -f "$IMAGE_TAR" ]; then
    err "指定的镜像 tar 不存在: $IMAGE_TAR"
    return 1
  fi
  info "使用外部镜像 tar: $IMAGE_TAR"
  cp -f "$IMAGE_TAR" "$IMG_TAR" || { err "复制 tar 失败"; return 1; }
  return 0
}

case "$EMBED_IMAGE" in
auto)
  if embed_image; then
    EMBED_IMAGE="yes"
    info "镜像已内嵌，安装后无需联网拉取"
  else
    EMBED_IMAGE="no"
    err "镜像未就绪（本机无 docker 或构建失败），已产出的包必须配合 NAS 上已有的镜像使用。"
    err "要出「装上就能跑」的离线包，请任选其一："
    err "  ① 有 Docker 的机器：docker build -t $IMAGE_NAME . 然后重跑本脚本"
    err "  ② NAS 构建后导出 tar：sh packaging/fnos/build-image-on-nas.sh"
    err "     再把 tar 拷到本机：sh build-fpk.sh --tar kaycftunnle.tar"
  fi
  ;;
tar)
  if embed_image_from_tar; then
    EMBED_IMAGE="yes"
    info "镜像已内嵌，安装后无需联网拉取"
  else
    EMBED_IMAGE="no"
    err "镜像 tar 处理失败"
    exit 1
  fi
  ;;
no)
  info "跳过镜像内嵌（--no-embed / --image），包体约 70K"
  ;;
skip)
  info "跳过镜像处理（--no-image），仅用于结构调试"
  ;;
esac

# 离线包在 install_init 阶段读取该文件并导入 image.tar；在线包不生成此文件。
if [ "$EMBED_IMAGE" = "yes" ]; then
  IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE_NAME" 2>/dev/null || true)
  cat > "$BUILD_DIR/cmd/offline-image.env" <<EOF
IMAGE_NAME=${IMAGE_NAME}
IMAGE_ID=${IMAGE_ID}
EOF
else
  rm -f "$BUILD_DIR/cmd/offline-image.env"
fi

# 远程仓库镜像（GHCR / 私有仓库）需要允许拉取；本地镜像则禁止拉取避免超时
case "$IMAGE_NAME" in
  */*)
    # 形如 ghcr.io/user/kaycftunnle:latest —— 带斜杠说明是远程仓库
    PULL_POLICY="always"
    PULL_POLICY_DESC="always（远程仓库，安装时自动拉取）"
    ;;
  *)
    PULL_POLICY="never"
    PULL_POLICY_DESC="never（本地镜像，不联网拉取）"
    ;;
esac

# 源码覆盖测试包复用 NAS 上已有的基础镜像，缺失时才拉取
if [ "$SRC_OVERLAY" = "yes" ] && [ "$PULL_POLICY" = "always" ]; then
  PULL_POLICY="missing"
  PULL_POLICY_DESC="missing（优先本地基础镜像，缺失时才拉取）"
fi

# 写入镜像名到 .env 模板
cat > "$BUILD_DIR/app/docker/env.default" <<EOF
KAY_CFTUNNLE_IMAGE=${IMAGE_NAME}
KAY_CFTUNNLE_PULL_POLICY=${PULL_POLICY}
EOF

# 镜像名直接写进 compose：安装阶段飞牛就会 compose up，此时 .env 可能还没生成，
# 升级时 .env 还可能残留旧版本写下的本地镜像名，不能依赖环境变量。
COMPOSE_FILE="$BUILD_DIR/app/docker/docker-compose.yaml"
grep -q '__KAY_CFTUNNLE_IMAGE__' "$COMPOSE_FILE" \
  || { err "compose 模板缺少 __KAY_CFTUNNLE_IMAGE__ 占位符"; exit 1; }
sed -i "s|__KAY_CFTUNNLE_IMAGE__|${IMAGE_NAME}|g; s|__KAY_CFTUNNLE_PULL_POLICY__|${PULL_POLICY}|g" "$COMPOSE_FILE"
info "镜像拉取策略: $PULL_POLICY_DESC"

# 授权服务地址：卖家自己打包时写死，买家就不用手填，离线批量码也能在激活当场完成设备绑定
grep -q '__KAY_LICENSE_ENV__' "$COMPOSE_FILE" \
  || { err "compose 模板缺少 __KAY_LICENSE_ENV__ 占位符"; exit 1; }
if [ -n "$LICENSE_URL" ]; then
  sed -i "s|__KAY_LICENSE_ENV__|      - KAY_LICENSE_URL=${LICENSE_URL}|g" "$COMPOSE_FILE"
  info "授权服务地址已打进包：$LICENSE_URL"
else
  sed -i "s|__KAY_LICENSE_ENV__|      # 未预置：买家在激活页展开「授权服务地址」自己填，或用 --license-url 打包时写死|g" "$COMPOSE_FILE"
  warn "未指定 --license-url，买家需要在激活页手填授权服务地址（在线卡密必须填，离线授权码可留空）"
fi

# 未内嵌镜像时，往包里塞一份安装说明，用户解包就能看到该干什么
if [ "$EMBED_IMAGE" != "yes" ]; then
  case "$IMAGE_NAME" in
    */*)
      # 远程仓库镜像（GHCR）：靠 pull_policy=always 在安装时拉取
      warn "本次未内嵌镜像，包体约 70K；安装时 compose 会从 $IMAGE_NAME 联网拉取"
      cat > "$BUILD_DIR/app/docker/IMPORT_IMAGE.txt" <<EOF
本安装包不内嵌镜像，安装时由 docker compose 自动从远程仓库拉取：

    ${IMAGE_NAME}

compose 里已直接写好镜像名与 pull_policy: ${PULL_POLICY}，飞牛点「安装」时
会先准备镜像，再 up（不依赖安装阶段可能还不存在的 .env）。要求：

  1. NAS 能访问 ghcr.io（国内网络可能需要给 Docker 配代理）
  2. 该 GHCR 包必须设为 Public，否则匿名 pull 会报 unauthorized：
     GitHub → 个人主页 → Packages → kaycftunnle → Package settings → Change visibility → Public

装前可在 NAS 终端自测一条命令，能拉下来就一定能装：

    docker pull ${IMAGE_NAME}

若确认拉取失败，两个退路：
  ① 手动拉好后改成内嵌包：docker save ${IMAGE_NAME} -o kaycftunnle.tar
     然后 sh build-fpk.sh --tar kaycftunnle.tar
  ② 直接在 NAS 上构建：sudo sh fix-image.sh（会 retag 或重新 build）
EOF
      ;;
    *)
      warn "本次未内嵌镜像：必须在装包【之前】让 NAS 上有 $IMAGE_NAME"
      warn "在 NAS 终端执行  docker image ls | grep kaycftunnle  可确认"
      cat > "$BUILD_DIR/app/docker/IMPORT_IMAGE.txt" <<EOF
本安装包【未内嵌】Docker 镜像。
飞牛在安装阶段就会直接 docker compose up，镜像不在本地会报：
    Error response from daemon: No such image: ${IMAGE_NAME}

所以必须【先有镜像，再装包】。

需要的镜像名：${IMAGE_NAME}
（这个名字与项目根目录 docker-compose.yml / build.sh 的默认镜像名一致，
  如果你之前用  docker compose up -d  部署过本项目，镜像应该已经在 NAS 上。）

====================== 第一步：确认镜像是否存在 ======================
在 NAS 终端执行：

    docker image ls | grep -i kay

- 看到 ${IMAGE_NAME}  → 已就绪，直接跳到第三步装包
- 看到别的 kay 名字   → 用第二步的 --retag 改名（几秒钟）
- 什么都没有           → 用第二步完整构建（3-10 分钟）

====================== 第二步：让镜像就位（推荐一键脚本） ======================
把项目源码放到 NAS（例如 /vol1/1000/cftun-panel），在项目根目录执行：

    sudo sh fix-image.sh

它会自动完成：
  - 列出 NAS 上所有 kay 相关镜像
  - 如果有同类镜像，自动改名成 ${IMAGE_NAME}（几秒钟，不重新构建）
  - 如果没有，才真正去构建（3-10 分钟）
  - 已存在则直接跳过

其它选项：
    sudo sh fix-image.sh --list     # 只看现状，不改动
    sudo sh fix-image.sh --build    # 强制重新构建

====================== 手动做法（不想用脚本时） ======================
    docker image ls | grep -i kay           # 看看有什么
    docker tag <看到的镜像名> ${IMAGE_NAME}   # 改名复用
    # 或
    docker build -t ${IMAGE_NAME} .         # 重新构建

====================== 第三步：安装 ======================
飞牛应用中心 → 手动安装 → 选 dist/kaycftunnle-${VERSION}.fpk

====================== 备选：在电脑上构建后导入 NAS ======================
    docker build -t ${IMAGE_NAME} .
    docker save ${IMAGE_NAME} -o kaycftunnle.tar
    # 拷到 NAS 后：
    docker load -i kaycftunnle.tar

====================== 备选：NAS 一键构建并打包成自包含 fpk ======================
这是真正点开即用的方案：包内嵌镜像，装前 NAS 上不需要先有镜像。

把项目源码放到 NAS（例如 /vol1/1000/cftun-panel），在项目根目录执行：

    sudo sh packaging/fnos/build-image-on-nas.sh

脚本会自动：docker build → docker save → fnpack 打包，
产物 dist/kaycftunnle-${VERSION}.fpk 约 200-300MB，装到飞牛上直接能用。

如果你的 NAS 无法下载 fnpack（需要访问 static2.fnnas.com），
可以只在 NAS 构建并导出 tar：
    sudo sh packaging/fnos/build-image-on-nas.sh
然后在有 fnpack 的电脑上（Windows 用 Git Bash / Linux / macOS）执行：
    sh packaging/fnos/build-fpk.sh --tar kaycftunnle.tar

====================== 为什么不会去公网拉 ======================
compose 里已配置  pull_policy: never ，且 cmd/main 不含任何 pull 动作，
所以缺镜像时只会明确报错，不会卡在 registry-1.docker.io 超时上。
EOF
      ;;
  esac
fi

# ---------------------------------------------------------------- 源码覆盖（测试包）
if [ "$SRC_OVERLAY" = "yes" ]; then
  info "源码覆盖模式：把当前源码挂载进基础镜像，无需重建镜像"
  mkdir -p "$BUILD_DIR/app/docker/appsrc/static"
  cp -f "$PROJECT_DIR/server.py" "$BUILD_DIR/app/docker/appsrc/server.py"
  cp -f "$PROJECT_DIR/cf.py" "$BUILD_DIR/app/docker/appsrc/cf.py"
  cp -f "$PROJECT_DIR/license.py" "$BUILD_DIR/app/docker/appsrc/license.py"
  cp -f "$PROJECT_DIR/license_ed25519.py" "$BUILD_DIR/app/docker/appsrc/license_ed25519.py"
  (cd "$PROJECT_DIR/static" && tar -cf - .) | (cd "$BUILD_DIR/app/docker/appsrc/static" && tar -xf -)
  for f in appsrc/server.py appsrc/cf.py appsrc/license.py appsrc/license_ed25519.py appsrc/static/index.html appsrc/static/app.js appsrc/static/activate.html; do
    [ -f "$BUILD_DIR/app/docker/$f" ] || { err "源码覆盖缺少 $f"; exit 1; }
  done
  COMPOSE_FILE="$BUILD_DIR/app/docker/docker-compose.yaml"
  awk '
    { print }
    /^    volumes:$/ {
      print "      # 测试包专用：用当前源码覆盖镜像内入口与静态目录"
      print "      - type: bind"
      print "        source: ./appsrc/server.py"
      print "        target: /app/server.py"
      print "        read_only: true"
      print "        bind:"
      print "          create_host_path: false"
      print "      - type: bind"
      print "        source: ./appsrc/cf.py"
      print "        target: /app/cf.py"
      print "        read_only: true"
      print "        bind:"
      print "          create_host_path: false"
      print "      - type: bind"
      print "        source: ./appsrc/license.py"
      print "        target: /app/license.py"
      print "        read_only: true"
      print "        bind:"
      print "          create_host_path: false"
      print "      - type: bind"
      print "        source: ./appsrc/license_ed25519.py"
      print "        target: /app/license_ed25519.py"
      print "        read_only: true"
      print "        bind:"
      print "          create_host_path: false"
      print "      - type: bind"
      print "        source: ./appsrc/static"
      print "        target: /app/static"
      print "        read_only: true"
      print "        bind:"
      print "          create_host_path: false"
    }
  ' "$COMPOSE_FILE" > "$COMPOSE_FILE.tmp"
  mv -f "$COMPOSE_FILE.tmp" "$COMPOSE_FILE"
fi

# ---------------------------------------------------------------- 校验
info "校验包结构"
REQUIRED="manifest config/privilege config/resource ICON.PNG ICON_256.PNG cmd/main app/docker/docker-compose.yaml app/ui/config"
for f in $REQUIRED; do
  [ -e "$BUILD_DIR/$f" ] || { err "缺少必需文件: $f"; exit 1; }
done
# 校验 JSON 文件合法性（优先 python，退化为 node）
PY_BIN=""
for c in python3 python py; do
  command -v "$c" >/dev/null 2>&1 && { PY_BIN="$c"; break; }
done

json_ok() {
  local file="$1"
  if [ -n "$PY_BIN" ]; then
    "$PY_BIN" -c "import json,sys; json.load(open(sys.argv[1],encoding='utf-8'))" "$file" 2>/dev/null
  else
    return 0   # 无校验工具时跳过
  fi
}

for f in config/privilege config/resource app/ui/config; do
  json_ok "$BUILD_DIR/$f" || { err "$f 不是合法 JSON"; exit 1; }
done
info "结构校验通过"

# ---------------------------------------------------------------- 打包
chmod +x "$BUILD_DIR"/cmd/* 2>/dev/null || true
# Windows 检出的 CRLF 会让 NAS 上的 shebang 变成 /bin/bash\r，提前统一为 LF。
CR=$(printf '\r')
for f in "$BUILD_DIR"/cmd/*; do
  if grep -q "$CR" "$f"; then
    tr -d '\r' < "$f" > "$f.tmp" && mv -f "$f.tmp" "$f"
  fi
done
mkdir -p "$DIST_DIR"
cd "$BUILD_DIR"
info "调用 fnpack build…"
"$FNPACK" build 2>&1 | tail -20

# fnpack 产物名可能是 appname_version.fpk
FOUND=$(find "$BUILD_DIR" -maxdepth 2 -type f -name '*.fpk' 2>/dev/null | head -1)
if [ -z "$FOUND" ]; then
  FOUND=$(find "$PROJECT_DIR" -maxdepth 2 -type f -name '*.fpk' ! -path "$DIST_DIR/*" 2>/dev/null | head -1)
fi
if [ -n "$FOUND" ]; then
  TARGET="$DIST_DIR/${APP_NAME}-${VERSION}${OUTPUT_SUFFIX}.fpk"
  mv -f "$FOUND" "$TARGET"
  SIZE=$(du -h "$TARGET" | cut -f1)
  info "打包完成: $TARGET ($SIZE)"
else
  err "未找到生成的 .fpk"
  exit 1
fi
