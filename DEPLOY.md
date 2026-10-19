# Kay-cftunnle 部署指南

> 默认账号：`admin` ｜ 默认密码：`123456`  
> 项目已开启无密码模式，首次打开面板通常无需登录即可使用。如需关闭无密码模式，请修改 `data/workbench.json` 中 `panel.no_auth_run` 为 `false`。

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
      - DASHBOARD_PORT=8000
    ports:
      - "8000:8000"
    volumes:
      - ./data:/app/data
      - ./runtime:/app/runtime
```

### 3. 启动

```bash
docker compose up -d
```

### 4. 访问

浏览器打开 `http://<你的服务器IP>:8000`

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
| 打开后是**别的应用**（如 Kay-WebCheck-in） | 8000 端口被其他容器占用，kaycftunnle 没抢到端口。先 `docker ps --format '{{.Names}}\t{{.Ports}}'` 看谁占了 8000，然后把本项目改成 `8100:8000` 重新部署，访问 `http://NAS_IP:8100`。 |
| `No such image: kaycftunnle:latest` | 说明你安装的 fpk 是轻量版，没有内嵌镜像。请改用方式二在 NAS 上重新打包。 |
| `context deadline exceeded` / Docker Hub 超时 | Dockerfile 默认从 Docker Hub 拉取基础镜像，网络不佳时会超时。可在 NAS 上先 `docker pull` 国内镜像，再构建；或换用方式一直接拉取 GHCR 镜像。 |
| 打不开 8000 端口 | 检查 NAS 防火墙 / 安全组是否放行 8000 端口。 |
| 登录提示密码错误 | 默认密码已改为 `123456`。如果仍失败，检查 `data/workbench.json` 是否已开启无密码模式。 |

---

## GHCR 镜像可见性

首次推送后，镜像包默认是 **Private**。其他用户/你的 NAS 直接拉取会报未授权，需要到 GitHub 设置为 Public：

1. 打开 https://github.com/kaynai1?tab=packages
2. 点击 `kaycftunnle`
3. 右侧 **Package settings** → **Change visibility** → **Public** → 保存
