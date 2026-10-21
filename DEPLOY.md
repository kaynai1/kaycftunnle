# Kay-cftunnle 部署指南

> **1.6.0 起需要激活，1.7.0 起支持离线**：首次打开会进入激活页，用在线卡密（`KAY-XXXX-XXXX-XXXX`）或离线授权码（`KAYO-…`）绑定当前 NAS 后才能使用；授权服务（Cloudflare Worker）与发卡流程见 [license-worker/README.md](./license-worker/README.md)。  
> 默认免密：激活后打开面板即管理员视图，无需登录。  
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
      # 可选：预置授权服务地址；不填则首次打开时在激活页输入
      # 只用离线授权码（KAYO-…）的买家不需要这一项
      # 建议用自定义域名（在 Cloudflare Worker 里绑域名），*.workers.dev 在部分网络访问不通
      - KAY_LICENSE_URL=https://<你的授权域名>
      # 可选：断网离线宽限天数（针对在线卡密），默认 7
      - KAY_OFFLINE_GRACE_DAYS=7
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

## 激活面板（1.6.0+，1.7.0 起支持离线）

面板首次启动处于未激活状态：访问 `http://NAS_IP:8567` 会跳到 `/activate.html`，连接器也不会启动。激活页有**两种授权**并列，买家按自己的网络情况选一个即可。

### 在线卡密（20 位短码，需要 NAS 能访问授权服务）

形如 `KAY-XXXX-XXXX-XXXX`，一眼能抄下来，不用先问买家机器码：卖家批量出卡，买家首次激活时自动绑上他那台设备。代价是 NAS 联网时要能访问授权服务域名，之后每 6 小时校验一次。

1. **部署授权服务**：按 [license-worker/README.md](./license-worker/README.md) 把 Worker 部署到 Cloudflare，绑定 KV，并设置 `ADMIN_TOKEN` / `ISSUE_TOKEN`。**强烈建议再绑一个自定义域名**（Cloudflare 控制台 → Worker → 设置 → 域名），`*.workers.dev` 在不少网络里访问不通。
2. **批量生成卡密**：打开 `https://<你的授权域名>/issue` → 「在线卡密」标签 → 顶栏填发卡令牌 → 填数量和备注 → 生成，把短码直接发给买家。想命令行出卡也可以：
   ```bash
   KAY_LICENSE_URL=https://<你的授权域名> \
   KAY_LICENSE_ADMIN_TOKEN=<ADMIN_TOKEN> \
   node admin.mjs new --count 10 --note "闲鱼 2026-10-21"
   ```
3. **激活设备**：打开面板激活页 → 选「在线卡密」→ 粘贴卡密 →（若未预置 `KAY_LICENSE_URL`）展开「授权服务地址」填你的域名 → 激活。买家自己的机器码在面板「设置 → 授权状态」里能看到，换机报错了发给你就行。
4. **日常管理**：同一张「在线卡密」台账里能看**买家设备**、最近校验、按设备码搜索，并提供解绑（换机）与吊销；命令行可用 `node admin.mjs list / show / revoke / restore / unbind`。

### 离线授权码（买家网络访问不了 Cloudflare 也能激活）

签发端能联网即可，**激活和日常使用完全不需要访问授权服务**。

1. **准备私钥**（只做一次）：在仓库根目录执行 `node tools/keygen.mjs`，得到
   - 口令加密后的 `KEY_BLOB` → 设为 Worker secret：`npx wrangler secret put KEY_BLOB`
   - 公钥 `OFFLINE_PUBLIC_KEY` → 粘贴进 `license.py` 并重新构建镜像；**公钥没内置时离线码一律被拒**
2. **设置签发口令**：`npx wrangler secret put ISSUE_TOKEN`（签发用的接口令牌，和管理面板的 `ADMIN_TOKEN` 分开）。
3. **发卡**：打开 `https://<Worker 域名>/issue`，输入 `ISSUE_TOKEN` + 私钥口令解锁（口令只在浏览器里派生成密钥，原文不上网）。
   - **一对一**：粘贴买家的机器码，选有效期（默认 365 天）后签发，把 `KAYO-…` 发给买家。
   - **批量预生成（推荐挂闲鱼自动发货）**：勾「不绑定机器码（批量预生成）」填数量（一次最多 100 张），先出一批码挂着，不用等买家发机器码。不在家时用本地工具 `node tools/issue.mjs` 也能签发。
4. **激活设备**：激活页选「离线授权码」→ 粘贴 `KAYO-…` → 激活。批量码在激活当场自动绑定这台机器，「签发台账 → 买家设备」列就能看到他的机器码。
5. **远程吊销 / 换机**：在 `/issue` 的「签发台账」里搜索编号并吊销/恢复；面板激活时报到一次、之后每 6 小时一次，**只有被明确吊销、或批量码已被别的设备认领（换机）才锁定**，网络不通或编号不认识都不会误锁。买家换机时点那一行的「解绑」，新设备下次报到自动绑上（写死机器码的码没有解绑，需重签）。

> 激活成功后状态保存在 `data/license.json`，重启容器不需要重新输入。在线卡密被吊销或换绑后立即停止连接器并要求重新激活，断网时进入离线宽限（默认 7 天）；离线授权码本地自校验、到期即失效，写死机器码的码换机要重新签发一条，批量预生成的码换机在发卡台点「解绑」即可。

---

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 打开后是**别的应用**（如 Kay-WebCheck-in） | 8567 端口被其他容器占用，kaycftunnle 没抢到端口。先 `docker ps --format '{{.Names}}\t{{.Ports}}'` 看谁占了 8567，再把 compose 里的映射改成别的宿主端口（例如 `"8600:8567"`）重新部署，访问 `http://NAS_IP:8600`。 |
| `No such image: kaycftunnle:latest` | 说明你安装的 fpk 是轻量版，没有内嵌镜像。请改用方式二在 NAS 上重新打包。 |
| `context deadline exceeded` / Docker Hub 超时 | Dockerfile 默认从 Docker Hub 拉取基础镜像，网络不佳时会超时。可在 NAS 上先 `docker pull` 国内镜像，再构建；或换用方式一直接拉取 GHCR 镜像。 |
| 打不开 8567 端口 | 检查 NAS 防火墙 / 安全组是否放行 8567 端口。 |
| **重启 NAS 后面板没自启**，应用中心报启动失败，手点一次就好了 | 飞牛的应用自启会抢在 Docker 守护进程前面跑，且失败不重试。`1.7.0-src-test6` 起：启动脚本最多等 Docker 就绪 60 秒并重试三次，「停止」不再删容器，`restart` 改为 `always`（开机由 Docker 直接拉起）。详见 `packaging/fnos/README.md` 的「重启 NAS 后面板没自启」。 |
| 连接器一直「启动中 → 已停止」，退出码 **0**，日志里全是 `--token/--url/--help` 这类参数说明 | 那段文字是 `cloudflared tunnel run --help` 的**帮助输出**，不是错误堆栈。cloudflared 只在两种情况下打印它：① 令牌为空（`--token ''`，被当成"没指定隧道"）；② 命令里有 `run` 子命令不认识的参数（例如把 `--protocol` / `--edge-ip-version` / `--no-autoupdate` 写在 `run` 之后）。两种情况都不会真正发起连接。新版已改为「参数放在 `run` 之前 + 被拒时自动降级为官方最小写法 + 启动前校验令牌」，并在日志里打印实际执行的命令（令牌被隐藏）。 |
| 想确认 cloudflared 到底拿到了什么输出 | 执行 `docker exec kaycftunnle tail -40 /app/runtime/connector.log`。第一行若是 `Incorrect Usage:` / `Usage:` 属于命令与令牌问题；若是 `failed to connect to edge` / `context deadline exceeded` 才是网络问题。 |
| 连接器能启动但一直连不上 / 超时 | QUIC 走 **UDP 7844**，不少家宽会封 UDP。把连接器协议从 `QUIC` 改成 `http2`（走 TCP 443）再试，成功率通常更高。 |
| 忘记登录密码 | 面板改密时会把新密码同步写进 `data/workbench.json` 的 `auth.password`，那里看到的就是当前密码。若数据库损坏，删掉 `data/kay-cftunnle.sqlite3` 再重启，服务会按 `workbench.json` 重新播种管理员（Cloudflare 侧的隧道与 DNS 不受影响，但本地规则缓存需重新拉取）。 |
| 打开面板总是跳激活页 | 未激活 / 卡密被吊销 / 离线宽限已过 / 离线授权码已到期。激活页顶部会写明原因；卡密被吊销需联系管理员恢复或换卡，宽限过期可联网后点「立即校验」。 |
| 离线授权码提示「无法解析」或「签名无效」 | ① 镜像里的 `license.py` 还是旧的 `OFFLINE_PUBLIC_KEY = ""`（公钥没内置，离线码一律被拒）——重新构建镜像；② 粘贴时漏了 `KAYO-` 前缀或被换行截断；③ 这条码是用另一对私钥签发的，和当前内置公钥不匹配。 |
| 离线授权码提示「不匹配本机机器码」 | 授权码绑死了签发时的那台 NAS。换机/重装后要把新机器码发给你，在 `/issue` 重新签发一条；批量预生成（不绑定机器码）的码不受这条限制。 |
| 批量码激活后面板显示「授权码已绑定其他设备」 | 这张码已被第一台激活的设备自动绑定（码被转卖或买家重装了系统又换了机器）。在 `/issue` 台账搜到该编号点「解绑」，让买家**先停掉旧设备上的面板**再在新机器激活，否则旧设备下次报到会把绑定抢回去。 |
| 吊销了离线授权码但面板没锁 | 面板要等下一次 6 小时报到，或到「设置 → 授权」点「立即校验」才生效；NAS 完全断网时报到发不出去，属于设计内的「尽力吊销」——网络恢复后会自动锁。 |
| 提示「这张卡密已绑定另一台设备」 | 卡密与第一台 NAS 的机器码绑定。让管理员执行 `node admin.mjs unbind KAY-XXXX-XXXX-XXXX`，旧设备随即失效，新设备再用同一张卡密激活。 |
| 激活提示「无法连接授权服务」 | NAS 需要能主动访问 Worker 的 HTTPS 域名。面板授权请求**不走系统代理**（避免 NAS 上的全局代理干扰）；若 Worker 前面套了自定义域名，请确认 DNS 与证书已生效。买家网络确实访问不了 Cloudflare 时，改用**离线授权码**激活，激活后面板不再依赖授权服务。 |
| 忘记面板激活的卡密 | 激活页和设置页只显示掩码（末 4 位）。可在 Worker 管理端用 `node admin.mjs list` 按机器码或备注查回完整卡密。 |

---

## GHCR 镜像可见性

首次推送后，镜像包默认是 **Private**。其他用户/你的 NAS 直接拉取会报未授权，需要到 GitHub 设置为 Public：

1. 打开 https://github.com/kaynai1?tab=packages
2. 点击 `kaycftunnle`
3. 右侧 **Package settings** → **Change visibility** → **Public** → 保存
