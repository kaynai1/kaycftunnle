# Kay-cftunnle 面板 · Cloudflare Tunnel 自托管管理

把 Cloudflare Tunnel 的日常操作收进一个自托管 Web 面板：API Token 托管、隧道管理、Ingress 映射、DNS CNAME 维护、cloudflared 连接器控制。**Python 标准库 + SQLite + 原生前端，零第三方运行依赖**，一条命令部署到飞牛 NAS。

> 仅供学习与研究使用。  
> **首次使用需激活**：打开面板会进入激活页，用在线卡密（`KAY-XXXX-XXXX-XXXX`）或离线授权码（`KAYO-…`）激活并绑定当前 NAS；未激活、被吊销、到期或超出离线宽限时，面板与连接器均不可用。授权服务部署见 [license-worker/README.md](./license-worker/README.md)。  
> **默认免密进入：激活后打开面板即管理员视图，无需登录**（旧配置升级后会一次性迁移到免密）。  
> 面板持有 Cloudflare Token 权限：若面板可能被公网访问，请到「设置 → 访问保护」关闭免密并设置密码。默认账号 `admin` / 默认密码 `123456`。

## 快速开始

- **Docker Compose 一键部署**：见 [DEPLOY.md](./DEPLOY.md#方式一docker-compose-一键部署推荐)
- **飞牛 fnOS 一键 fpk 安装**：见 [DEPLOY.md](./DEPLOY.md#方式二飞牛-fnos-nas-一键-fpk-安装)
- **本地源码构建**：

```bash
git clone https://github.com/kaynai1/kaycftunnle.git
cd kaycftunnle
docker compose up -d --build
```

### 旧版 zip 部署路线

```bash
# 上传部署包 zip 到 NAS（或把源码目录整个传上去）
# 进入源码目录执行一键部署
sh deploy-kay-cftunnle.sh
```

脚本自动完成：Docker 探测 → 环境自检 → 定位解压 → 安装（保留已有配置）→ 构建启动 → 自检。

- 访问地址：`http://NAS_IP:8567`
- 登录方式：默认免密（打开即进入）；需要登录时到「设置 → 访问保护」关闭免密，再用 `admin` / `123456` 登录并修改密码
- 安装目录：`/vol1/1000/qd/kay-cftunnle`（数据落在这里，容器删了数据还在）
- 开机自启：Docker 部署已带 `restart: unless-stopped`；systemd 部署已执行 `systemctl enable kay-cftunnle`，NAS 重启后自动启动

### 本地开发（Windows）

```bash
python server.py --port 8567     # 或 python3
# 浏览器打开 http://127.0.0.1:8567
python server.py --check         # 只跑一次自检，打印状态 JSON
```

## 激活与授权（1.6.0+，1.7.0 起支持离线）

首次打开面板会跳到 `/activate.html`，激活完成后才会进入管理界面。激活页顶部有两种方式并列：

1. 页面会显示当前设备的机器码（`NAS-XXXX-XXXX-XXXX`），可一键复制。
2. **在线卡密**（默认标签）：输入 `KAY-XXXX-XXXX-XXXX`；如果未预置授权服务地址，展开「授权服务地址」填写。
3. **离线授权码**（另一个标签）：粘贴卖家签发的 `KAYO-…` 长码，本地验签即可激活，**不需要能访问 Cloudflare**。
4. 激活成功后授权与当前机器码绑定，之后重启、升级容器都不需要重新输入。

授权服务是一套独立的 Cloudflare Worker + KV，部署步骤、卡密生成、离线签发与吊销命令见 [license-worker/README.md](./license-worker/README.md)。
私钥只以口令加密的密文存在 Worker 密钥里，`ADMIN_TOKEN`、`ISSUE_TOKEN` 与口令都只在售卖者手上，面板和买家拿不到；面板源码里只有验签用的公钥。

面板端行为：

- **在线卡密**：每 6 小时校验一次；断网不影响使用，进入离线宽限，默认 7 天（`KAY_OFFLINE_GRACE_DAYS`）。
- **离线授权码**：本地 Ed25519 验签，断网可长期用；填了授权服务地址时每 6 小时报到一次，只有服务端明确回「已吊销」才锁定，连不上不影响使用。到期时间写在签名里（默认 365 天，可签成永久），改系统时间会被高水位时间戳挡下。
- **锁定**：卡密被吊销、绑定到其他设备、离线授权被吊销或到期、离线宽限结束时，立即停止连接器、API 返回 403，页面自动跳回激活页。
- **换机**：在线卡密由管理员在 Worker 端解绑后，新设备用同一张卡密重新激活；离线授权码绑在签名里改不了，换机需重新签发一张。
- **状态文件**：`data/license.json`（含卡密或授权码与机器码），随 `data/` 卷持久化，请勿公开。
- **授权服务地址不暴露给浏览器**：前端只请求面板自己的 `/api/license/*`，由面板后端转发到 Worker；状态接口只返回 `server_configured` 布尔值，激活页默认隐藏该栏（点「更换授权服务地址」才会出现输入框）。买家的浏览器、页面源码里看不到 Worker 域名。
- **抗刷**：Worker 侧按 IP 限流（公开接口 60 次/分钟、管理接口 30 次/分钟、签发 5 次/分钟），卡密为 60 bit 随机不可枚举，签发接口还要能解开私钥密文。详见 [license-worker/README.md](./license-worker/README.md) 的「暴露面与防刷」。

## 总览页三步流程

新装第一次打开面板，所有操作都在**总览**一页完成：

1. **填凭据**：Account ID（可留空，自动识别）与 API Token，点「保存并验证」。验证报告会列出 Token 状态、账号、可见域名与 Tunnel 权限。
2. **建并连接隧道**：输入名称创建隧道（也可复用已有隧道），点「连接」，等状态显示「已连接」——面板会轮询云端，确认 cloudflared 与本机连接真正建立。
3. **添加访问规则**：连接成功后才展开规则表单。子域名、目标域名、本地服务（端口 `8000` 或完整地址 `ssh://127.0.0.1:22`），保存时自动写隧道路由并创建已代理 CNAME。

> 未连接隧道时规则区保持锁定；断开连接后同样会收起。换隧道只需在隧道列表点另一条的「连接」。

> 下发隧道路由前，面板会先读取该隧道当前配置，**保留 Cloudflare 后台手写的 hostname**，只覆盖面板自己管理的同名规则；读取失败则取消下发，避免误删。

> 规则的增删改会先落本地库并立即回包，DNS 记录与隧道路由随后在后台同步；网络慢时按钮不会一直转圈，后台同步失败会写进操作日志，规则行也会显示「DNS 已缺失 / 路由未下发」。

## 配置 Cloudflare 凭据

在 [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens) 创建自定义 Token，权限：

| 资源 | 权限 | 级别 |
|---|---|---|
| 账户 | Cloudflare Tunnel | 编辑 + 读取 |
| 区域 | DNS | 编辑 + 读取 |
| 区域 | 区域 | 读取 |

面板「总览」页填入 Token，点**保存并验证**即可：自动完成 Token 校验、账号发现（单账号自动回填 Account ID），并按权限缺失给出提示。域名在添加 DNS 记录时按需选择（M3），无需在此预设。

「连接器」页内的「系统设置」卡可保存连接器参数（**系统重启后自动连接**、**进程看门狗**、连接协议 HTTP/2 / QUIC、IP 版本 IPv4 / IPv6），启动连接器时立即读取。自动连接出厂就是开的：开机时先绑端口再在后台连隧道，网络没就绪会按 10/20/40/60/120/180 秒重试，连上哪条隧道就记成默认，下次重启还连同一条。

### 进程看门狗

cloudflared 运行在 NAS 上可能需要连续不间断。服务端内置看门狗线程，每 5 秒检测一次进程：

- 进程**意外退出**时记录退出码、运行时长与日志尾部原因，并写一条 error 级审计日志
- 按指数退避自动拉起（2 → 4 → 8 → 16 → 32 → 60 秒），最多重试 5 次
- 达到上限后停止拉起，并在连接器页显示「已停止拉起」，避免死循环刷日志
- 用户手动「停止」不会触发看门狗；手动「启动 / 重启」会重置重试计数与退出记录

## 一条规则怎么才算通

域名要能打开需要三件事同时成立，面板把前两项的缺失都标在规则行上：

1. **隧道路由（Ingress）**：写入 Cloudflare 的 `cfd_tunnel/{id}/configurations`，形如 `hostname → http://127.0.0.1:5678`；每条隧道的规则列表末尾自动补 `http_status:404` 兜底。缺了它，请求到边缘就报 502/1033。
2. **DNS CNAME**：`子域名 → <隧道ID>.cfargotunnel.com`，且必须开启橙色云（代理）。缺了它，域名根本不进 Cloudflare 网络。
3. **连接器在跑**：`cloudflared tunnel run --token <令牌>` 连上这条隧道（总览页隧道状态显示「已连接」）。缺了它，边缘找不到回源出口。

隧道一律用 `config_src=cloudflare`（远程托管）创建，所以只需要 `--token` 启动，路由由面板通过 API 下发，NAS 上不需要任何本地 `config.yml`。

## API 一览（默认免密；关闭免密后均需登录。业务错误返回 HTTP 200 + `{ok:false}`）

| 方法与路径 | 用途 |
|---|---|
| `GET /api/health` | 存活探活（无需登录） |
| `GET /api/license/status` · `POST /api/license/activate` · `POST /api/license/verify` · `POST /api/license/server` | 授权状态 / 激活 / 立即校验 / 保存授权服务地址（未激活时也可访问） |
| `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` | 登录 / 登出 / 当前用户 |
| `POST /api/auth/password` | 修改密码（改密后所有会话失效，需用新密码重新登录；设置页「面板密码」卡片已接入） |
| `GET /api/cloudflare/status` | 凭据状态（Token 脱敏显示） |
| `POST /api/cloudflare/settings` | 保存 Token / Account ID |
| `POST /api/cloudflare/verify` | 测试配置，返回结构化报告（Token/账号/权限） |
| `GET /api/cloudflare/zones` | 域名列表（M3 DNS 页使用） |
| `POST /api/cloudflare/zones/primary` | 设置当前目标 Zone（M3） |
| `GET /api/system/settings` · `POST /api/system/settings` | 连接器设置（自动连接 / 协议 / IP 版本 / 看门狗）与访问保护（免密开关） |
| `GET /api/system/info` | 面板版本、运行时长、数据目录、cloudflared 版本、服务进程 |
| `GET /api/system/selfcheck` | 版本自检：代码指纹、server.py 修改时间、关键路由是否已注册 |
| `GET /api/system/backup` · `POST /api/system/backup` | 导出 / 导入配置（不含密码与会话密钥） |
| `GET /api/tunnels` · `POST /api/tunnels` | 隧道列表 / 新建（名称：小写字母数字连字符，1-63 位） |
| `DELETE /api/tunnels/{id}` | 删除隧道（有活跃连接时 Cloudflare 会拒绝，先停止连接器） |
| `GET /api/tunnels/{id}/token` | 获取隧道连接令牌（敏感凭据，等同密码） |
| `GET /api/ingresses` · `POST /api/ingresses` | Ingress 规则列表 / 创建（写隧道路由 + 同步 CNAME） |
| `POST /api/ingresses/sync` | 把本地规则整份重新下发到各隧道的远程路由 |
| `POST /api/ingresses/{id}` | 编辑规则（改服务地址 / 换隧道；DNS 用 PUT 原地更新） |
| `DELETE /api/ingresses/{id}` | 删除规则（本地立即生效，DNS 记录与隧道路由后台清理） |
| `GET /api/cloudflare/dns-records` | 当前 Zone 全部 DNS 记录，标注哪些由面板维护 |
| `GET /api/connector/status` | 连接器状态：运行/二进制/PID/运行时间/看门狗/日志 |
| `POST /api/connector/start` · `/stop` · `/restart` | 启动 / 停止 / 重启 cloudflared |
| `POST /api/connector/clear-logs` | 清空连接器日志 |
| `POST /api/connector/default` | 设置默认启动隧道 |
| `GET /api/logs` | 最近操作审计日志 |

## 目录结构

```
kay-cftunnle/
├── server.py               # 服务端（标准库：HTTP + SQLite + 认证 + CF API 路由）
├── cf.py                   # Cloudflare API v4 客户端（urllib 实现）
├── license.py              # 授权：机器码、激活、在线校验、离线宽限与锁定、离线授权码验签入口
├── license_ed25519.py      # 纯标准库 Ed25519 验签（面板零依赖，离线授权码用）
├── license-worker/         # 授权服务（Cloudflare Worker + KV + 管理 CLI + /issue 发卡台）
├── tools/                  # 本地密钥生成与离线签发（keygen.mjs / issue.mjs，产物不入库）
├── static/                 # 前端（无构建步骤）
│   ├── index.html          #   页面骨架（登录 + 总览/域名/连接器/设置）
│   ├── app.js              #   业务逻辑（路由/凭据/隧道/规则/日志）
│   ├── activate.html       #   激活页（机器码 / 在线卡密 / 离线授权码 / 授权服务地址）
│   ├── activate.js         #   激活页交互
│   ├── activate.css        #   激活页样式
│   ├── styles.css          #   布局与组件
│   ├── theme.css           #   主题令牌（橙品牌 / 暖黑深色）
│   └── theme.js            #   明暗偏好预应用
├── deploy/
│   ├── install.sh          # systemd 部署路线（不用 Docker 时选它）
│   └── kay-cftunnle.service
├── deploy-kay-cftunnle.sh   # Docker 一键部署脚本
├── Dockerfile              # python:3.13-slim 多阶段构建，内置 cloudflared
├── docker-compose.yml
├── build.sh                # 本地多架构 Docker 构建
├── package.sh              # 生成飞牛 NAS 部署包 zip
├── .github/workflows/
│   └── docker.yml          # GitHub Actions 多架构镜像构建
├── data/                   # 运行期：workbench.json + kay-cftunnle.sqlite3
└── runtime/                # 运行期：cloudflared 进程与日志（M4 起）
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DASHBOARD_HOST` | `0.0.0.0` | 监听地址 |
| `DASHBOARD_PORT` | `8567` | 监听端口 |
| `DASHBOARD_TZ` | `Asia/Shanghai` | 时区 |
| `KAY_CFTUNNLE_ROOT` | 源码目录 | 工作台根目录 |
| `KAY_LICENSE_URL` | 空 | 授权服务地址（Worker 域名）；空则在激活页手动填写 |
| `KAY_OFFLINE_GRACE_DAYS` | `7` | 断网离线宽限天数 |

## M5 交付：多架构构建与打包

### Docker 多架构镜像

```bash
# 本地构建并推送（需要 Docker buildx + 登录镜像仓库）
sh build.sh ghcr.io/<用户名>/kay-cftunnle:latest

# 或指定仓库前缀
REGISTRY=ghcr.io/<用户名> sh build.sh latest
```

构建产物支持 `linux/amd64` 与 `linux/arm64`，覆盖飞牛 NAS 常见 x86/ARM 机型。

### GitHub Actions 自动构建

仓库已配置 `.github/workflows/docker.yml`：

- 推送到 `main` / `master` 或 tag `v*` 时自动触发
- 自动构建并推送多架构镜像到 `ghcr.io/<用户名>/kay-cftunnle`
- 首次使用需在仓库 Settings → Actions → General → Workflow permissions 勾选 `read and write permissions`，让 `GITHUB_TOKEN` 能推送镜像

### 生成飞牛 NAS 部署包

```bash
sh package.sh
# 输出：dist/Kay-cftunnle面板-飞牛NAS部署包-<版本>.zip
```

把 zip 上传到 NAS 后直接执行：

```bash
sh deploy-kay-cftunnle.sh /实际路径/Kay-cftunnle面板-飞牛NAS部署包-*.zip
```

### systemd 路线（无 Docker 时）

```bash
# 从源码根目录执行
sudo sh deploy/install.sh
```

该路线会自动下载并安装 `cloudflared` 二进制到 `/usr/local/bin`。

## 里程碑

- [x] **M1 骨架**：Docker + HTTP 服务 + SQLite + 本地认证 + 登录/面板框架 + 一键部署
- [x] **M2 Cloudflare API 层**：Token 验证（结构化报告 + 账号/域名自动发现）、隧道 CRUD、修改密码、操作审计日志
- [x] **M3 Ingress + DNS**：规则编辑与同步、CNAME 自动维护
- [x] **M4 连接器**：cloudflared 生命周期、自动连接、协议/IP 选择、实时日志
- [x] **M5 交付**：多架构构建（amd64/arm64）、飞牛部署包打包、使用文档

## 常见问题

| 现象 | 处理 |
|---|---|
| 构建卡在 apt | 不是报错，Dockerfile 已换阿里云源；若仍慢可重跑 `docker compose up -d --build` |
| 构建卡在拉取 cloudflared | Dockerfile 已改用官方 `cloudflare/cloudflared` 镜像多阶段复制，无需访问 GitHub |
| 打不开页面 | 飞牛「系统设置 → 防火墙」放行 8567 |
| 页面提示「接口不存在：/xxx」 | 三步定位：① 页面报错处点「运行版本自检」，看 `all_routes_ok`；② `curl http://<NAS>:端口/api/system/selfcheck` 看 `code_sha` 与 `server_mtime`；③ 从容器内确认 `docker exec kay-cftunnle grep -c 'dns-records' /app/server.py`。返回 `0` 说明容器里是旧代码，执行 `cd <安装目录> && docker compose up -d --build --force-recreate`；返回非 `0` 说明代码是新的，强制刷新浏览器缓存（Ctrl+Shift+R）即可 |
| 想让面板重新要求登录 | 「设置 → 访问保护」关闭「免密访问」并保存。出厂默认开启免密；开启时任何能访问端口的人都能操作隧道与 DNS，公网部署务必关闭 |
| 验证提示「Invalid request headers」等 CF 错误码 | Token 无效或权限不足；错误码（6003/7003/10000 等）为 Cloudflare 原文，按提示检查 Token 与权限 |
| 连接器页显示「未安装」 | cloudflared 二进制不在 PATH 中；Docker 部署已内置，本地开发请下载并放到 PATH 或项目根目录 |
| 启动连接器提示「未找到 cloudflared」 | 同上；Windows 请把 `cloudflared.exe` 放在项目根目录或加入系统 PATH |
| NAS 重启后面板没自动启动 | Docker 路线检查 `restart: unless-stopped` 是否生效；systemd 路线执行 `systemctl status kay-cftunnle` |
| 连接器频繁自动重启 | 看连接器页「最近异常退出」里的退出码与日志尾部原因；连续 5 次失败后看门狗会停止拉起，修复后手动「重启」即可重置 |
| Ingress 规则显示「DNS 已缺失」 | 该子域名在 Cloudflare 上的 CNAME 被手工删除或改名；直接用「编辑」保存一次，或删除重建即可补回 |
| 规则齐全但域名打不开（502 / 1033 / Unable to reach origin） | 只有 CNAME 不够，隧道还要有自己的 ingress 路由。看规则上的「路由未下发」标记，点「↻ 重新下发路由」补写 |
| 连接器报 `flag provided but not defined: -edge-ip-version` | 容器里跑的是旧代码：`--protocol` / `--edge-ip-version` 属于 `tunnel` 全局参数，必须放在子命令 `run` **之前**。执行 `docker compose up -d --build --force-recreate` 后在「系统设置 → 运行版本自检」确认 `version` ≥ 1.2.0 且 `tunnel_route_sync` 为 true |
