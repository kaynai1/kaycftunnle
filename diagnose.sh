#!/bin/bash
# =============================================================================
# Kay-cftunnle · 安装环境诊断
#
# 用途：一条命令把「为什么装不上」的原因查出来，输出可直接复制发给别人。
#
# 用法（NAS 终端任意目录）：
#   sudo sh diagnose.sh
#
# 只读取信息，不改任何东西。
# =============================================================================

IMAGE="kaycftunnle:latest"
CONTAINER="kaycftunnle"

hr() { printf '%s\n' "------------------------------------------------------------"; }
sec() { echo; hr; echo "## $*"; hr; }

echo "Kay-cftunnle 安装环境诊断"
echo "时间：$(date '+%Y-%m-%d %H:%M:%S')"

# ---------------------------------------------------------------- 1. Docker 本体
sec "1. Docker 是否可用"
if command -v docker >/dev/null 2>&1; then
  echo "docker 路径：$(command -v docker)"
  echo "版本：$(docker --version 2>&1)"
  if docker info >/dev/null 2>&1; then
    echo "守护进程：运行中 ✓"
  else
    echo "守护进程：无权限或未运行 ✗"
    echo "  → 请用 sudo 执行本脚本，或在飞牛应用中心启用 Docker"
  fi
else
  echo "docker：未安装或不在 PATH ✗"
  echo "  → 飞牛应用中心 → 应用商店 → 安装「Docker」"
fi

# ---------------------------------------------------------------- 2. 相关镜像
sec "2. 本地所有 kay 相关镜像"
# 兼容新旧格式：优先用 --format，失败则退回普通输出再过滤
FOUND=$(docker image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -i kay | grep -v '<none>')
if [ -n "$FOUND" ]; then
  echo "$FOUND" | sed 's/^/  /'
  echo
  echo "以上镜像名可用于 --retag："
  echo "$FOUND" | sed 's/^/  - /'
else
  echo "（无）"
fi

# ---------------------------------------------------------------- 3. 目标镜像
sec "3. 目标镜像 $IMAGE 是否存在"
if docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "存在 ✓  可以直接去应用中心安装 fpk"
  docker image inspect "$IMAGE" -f '  ID: {{.Id}}
  创建: {{.Created}}
  大小: {{.Size}} bytes'
else
  echo "不存在 ✗  ← 这就是安装失败的直接原因"
fi

# ---------------------------------------------------------------- 4. 容器与网络残留
sec "4. 残留容器 / 网络（安装失败会留下项目）"
echo "容器："
docker ps -a --filter "name=$CONTAINER" --format '  {{.Names}}\t{{.Status}}\t{{.Image}}' 2>/dev/null || echo "  （查询失败）"
echo "网络："
docker network ls --format '{{.Name}}' 2>/dev/null | grep -i kay | sed 's/^/  /' || echo "  （无）"

# ---------------------------------------------------------------- 5. 端口
sec "5. 端口 8000 占用情况"
if command -v ss >/dev/null 2>&1; then
  ss -lntp 2>/dev/null | grep ':8000' || echo "  8000 空闲 ✓"
elif command -v netstat >/dev/null 2>&1; then
  netstat -lntp 2>/dev/null | grep ':8000' || echo "  8000 空闲 ✓"
else
  echo "  （无 ss / netstat，跳过）"
fi

# ---------------------------------------------------------------- 6. 磁盘
sec "6. 磁盘空间"
df -h / 2>/dev/null | tail -2
echo "Docker 占用："
docker system df 2>/dev/null || echo "  （查询失败）"

# ---------------------------------------------------------------- 7. 数据目录
sec "7. 应用数据目录"
for d in /vol1/@appdata/kaycftunnle /vol1/@appdata/kay-cftunnle; do
  if [ -d "$d" ]; then
    echo "$d 存在"
    ls -la "$d" 2>/dev/null | head -6 | sed 's/^/  /'
  fi
done
[ -d /vol1/@appdata/kaycftunnle ] || [ -d /vol1/@appdata/kay-cftunnle ] || echo "（无，属正常：安装成功后才创建）"

# ---------------------------------------------------------------- 8. 结论
sec "8. 结论与下一步"

if ! command -v docker >/dev/null 2>&1; then
  echo "→ 先装 Docker：飞牛应用中心 → 应用商店 → Docker"
elif docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "→ 镜像已就绪，直接去应用中心安装 kaycftunnle-1.0.0.fpk"
elif [ -n "$FOUND" ]; then
  echo "→ 有同类镜像但名字不匹配，用改名复用（几秒）："
  echo "    sudo sh build-on-nas.sh --retag $(echo "$FOUND" | head -1)"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "→ 镜像不存在，需要构建（3-10 分钟）："
  echo "    cd <项目源码目录> && sudo sh build-on-nas.sh"
else
  echo "→ Docker 守护进程不可用，先用 sudo 重跑本脚本确认权限"
fi

echo
hr
echo "诊断结束。把以上完整输出发回即可。"
