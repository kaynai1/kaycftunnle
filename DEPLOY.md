# Kay-cftunnle 部署指南

> 默认免密：打开面板即管理员视图，无需登录。  
> 面板持有 Cloudflare Token 权限，只应暴露在你信任的内网；若要公网可达，请先到「设置 → 访问保护」关闭免密（默认账号 `admin` / 默认密码 `123456`，登录后到「设置 → 面板密码」改掉），再用 Cloudflare Access 之类加一层。

---

## 方式一：Docker Compose 一键部署（推荐）

适合任意支持 Docker 的 NAS / Linux / 服务器，**无需 clone 源码**。

### 1. 创建部署目录

```bash
mkdir -p ~/kaycftunnle && cd ~/kaycftunnle
```

### 2. 下载一键部署文件

```bash
curl -fsSL https://raw.githubusercontent.com/kaynai1/kaycftunnle/main/docker-compose.deploy.yml -o docker-compose.yml
```

或者直接新建 `docker-compose.yml`，写入：

```yaml
services:
  kaycftunnle:
    image: ghcr.io/kaynai1/kaycftunnle:latest
    container_name: kaycftunnle
    restart: unless-stopped
    environment:
      - TZ=Asia/Shanghai
      - DASHBOARD_HOST=0.0.0.0
      - DASHBOARD_PORT=8567
    ports:
      - "8567:8567"
    volumes:
      - ./data:/app/data
      - ./runtime:/app/runtime
```

### 3. 启动

```bash
docker compose up -d
```

### 4. 访问

浏览器打开 `http://<你的服务器IP>:8567`

> 注意：首次推送后，GitHub Actions 需要 3-5 分钟构建镜像。如果提示镜像不存在，请到仓库 Actions 页面查看构建进度。

---

## 方式二：飞牛 fnOS NAS 一键 fpk 安装

在 NAS 上下载源码后执行打包脚本，生成真正**内含 Docker 镜像**的 `.fpk`，双击安装即可。

### 1. NAS 上安装必备工具

确保 NAS 已开启 SSH 并已安装 `git`、`docker`、`docker compose`。

### 2. 下载源码

```bash
ssh root@你的NAS_IP
cd /vol1/1000/qd  # 或你喜欢的目录
git clone https://github.com/kaynai1/kaycftunnle.git
cd kaycftunnle
```

### 3. 一键构建镜像并打包

```bash
sudo sh packaging/fnos/build-image-on-nas.sh
```

脚本会自动完成：
- 构建 `kaycftunnle:latest` 镜像
- `docker save` 导出镜像
- 下载 Linux 版 `fnpack`
- 打包成 `.fpk`（约 200-300MB）

### 4. 安装

将生成的 `dist/kaycftunnle-*.fpk` 下载到电脑，在飞牛 fnOS 应用中心点击**手动安装**，选择该 `.fpk` 即可。

安装完成后点击应用图标即可打开面板。

---

## 方式三：本地源码构建启动

适合二次开发或网络无法访问 GHCR 的环境。

```bash
# 1. clone 源码
git clone https://github.com/kaynai1/kaycftunnle.git
cd kaycftunnle

# 2. 本地构建并启动
docker compose up -d --build
```

---

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 打开后是**别的应用**（如 Kay-WebCheck-in） | 8567 端口被其他容器占用，kaycftunnle 没抢到端口。先 `docker ps --format '{{.Names}}\t{{.Ports}}'` 看谁占了 8567，再把 compose 里的映射改成别的宿主端口（例如 `"8600:8567"`）重新部署，访问 `http://NAS_IP:8600`。 |
| `No such image: kaycftunnle:latest` | 说明你安装的 fpk 是轻量版，没有内嵌镜像。请改用方式二在 NAS 上重新打包。 |
| `context deadline exceeded` / Docker Hub 超时 | Dockerfile 默认从 Docker Hub 拉取基础镜像，网络不佳时会超时。可在 NAS 上先 `docker pull` 国内镜像，再构建；或换用方式一直接拉取 GHCR 镜像。 |
| 打不开 8567 端口 | 检查 NAS 防火墙 / 安全组是否放行 8567 端口。 |
| 连接器一直「启动中 → 已停止」，退出码 **0**，日志里全是 `--token/--url/--help` 这类参数说明 | 那段文字是 `cloudflared tunnel run --help` 的**帮助输出**，不是错误堆栈。cloudflared 只在两种情况下打印它：① 令牌为空（`--token ''`，被当成"没指定隧道"）；② 命令里有 `run` 子命令不认识的参数（例如把 `--protocol` / `--edge-ip-version` / `--no-autoupdate` 写在 `run` 之后）。两种情况都不会真正发起连接。新版已改为「参数放在 `run` 之前 + 被拒时自动降级为官方最小写法 + 启动前校验令牌」，并在日志里打印实际执行的命令（令牌被隐藏）。 |
| 想确认 cloudflared 到底拿到了什么输出 | 执行 `docker exec kaycftunnle tail -40 /app/runtime/connector.log`。第一行若是 `Incorrect Usage:` / `Usage:` 属于命令与令牌问题；若是 `failed to connect to edge` / `context deadline exceeded` 才是网络问题。 |
| 连接器能启动但一直连不上 / 超时 | QUIC 走 **UDP 7844**，不少家宽会封 UDP。把连接器协议从 `QUIC` 改成 `http2`（走 TCP 443）再试，成功率通常更高。 |
| 忘记登录密码 | 面板改密时会把新密码同步写进 `data/workbench.json` 的 `auth.password`，那里看到的就是当前密码。若数据库损坏，删掉 `data/kay-cftunnle.sqlite3` 再重启，服务会按 `workbench.json` 重新播种管理员（Cloudflare 侧的隧道与 DNS 不受影响，但本地规则缓存需重新拉取）。 |

---

## GHCR 镜像可见性

首次推送后，镜像包默认是 **Private**。其他用户/你的 NAS 直接拉取会报未授权，需要到 GitHub 设置为 Public：

1. 打开 https://github.com/kaynai1?tab=packages
2. 点击 `kaycftunnle`
3. 右侧 **Package settings** → **Change visibility** → **Public** → 保存
