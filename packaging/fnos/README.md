# 飞牛 fnOS 安装包（fpk）构建与安装

本目录用于把 Kay-cftunnle 打包成飞牛应用中心的 `.fpk` 安装包。

## 一、先说结论：镜像必须先有，再装包

`.fpk` 里的 `app.tgz` **只装 compose 文件和图标，不装源码**。而 `config/resource` 里声明了
`docker-project`，飞牛在**安装阶段就会直接 `docker compose up`**（日志里能看到
`Network kaycftunnle_default Creating` → `Container kaycftunnle Creating`）。

这就意味着：**镜像不在本地，安装一定失败**，报错是：

```
Error response from daemon: No such image: kaycftunnle:latest
```

这个检查发生在飞牛自己的启动流程里，**不经过 `cmd/main`**，所以无法用脚本绕过。
只有两条路：**先让 NAS 上有本地镜像**，**或者让镜像来自一个能拉取的仓库**。

| 做法 | 命令 | 包体积 | 说明 |
|---|---|---|---|
| **A. NAS 上一键构建并打包（最稳，推荐）** | `sudo sh packaging/fnos/build-image-on-nas.sh` | 约 200–300 MB | 构建 + fnpack 全自动，直接产出点开即用的 fpk |
| B. GHCR 远程镜像 | 推代码到 GitHub，Actions 自动构建 | 约 67 KB | 装包时自动拉取，NAS 需能访问 ghcr.io |
| C. NAS 上先构建，再装轻量包 | `sudo sh fix-image.sh` 后安装 `dist/*.fpk` | 约 67 KB | 不依赖外网，构建 3–10 分钟 |
| D. 电脑构建后传过去 | 电脑 `docker save` → NAS `docker load` | 约 67 KB | 适合 NAS 拉不动基础镜像时 |
| E. 本机有 Docker 时一步到位 | `sh packaging/fnos/build-offline.sh` | 约 200–300 MB | 构建 + 打包全自动 |

> 当前仓库里的 `dist/kaycftunnle-1.0.0.fpk` 是 **67KB 版本**，默认走本地镜像
> `kaycftunnle:latest`（即 B/C/D 路线的前置条件）。
> 想要**点开即用**的包，请走 A 或 E。

### ⚠ 三次报错分别是什么原因

| 报错 | 原因 | 修复 |
|---|---|---|
| `registry-1.docker.io ... context deadline exceeded` | 镜像名不带前缀，Docker 当成 Docker Hub 镜像去拉，国内拉不动 | compose 加 `pull_policy: never` ＋ `cmd/main` 删掉所有 `compose pull` |
| `No such image: kaycftunnle:1.0.0` | 我为防拉取自己造了个 `local/kaycftunnle:1.0.0` 的名字，NAS 上根本没有 | 镜像名统一回 `kaycftunnle:latest` |
| `No such image: kaycftunnle:latest` | 名字对了，但 NAS 上确实没有这个镜像 | 走 A（GHCR）或 B（NAS 构建），见下 |

## 二、让 NAS 上有镜像

### 做法 A：NAS 上一键构建并打包成自包含 fpk（推荐，最稳）

把项目源码传到 NAS（例如 `/vol1/1000/cftun-panel`），在项目根目录执行：

```bash
sudo sh packaging/fnos/build-image-on-nas.sh
```

脚本会：
1. 检查 Docker 可用
2. `docker build -t kaycftunnle:latest .`
3. `docker save` 导出镜像
4. 自动下载 Linux 版 `fnpack`
5. 调用 `build-fpk.sh --tar` 把镜像塞进包内

产物：`dist/kaycftunnle-1.0.0.fpk`（约 200–300 MB）。

这个包**内嵌了完整镜像**，装到飞牛上：
- 不需要 NAS 上先有镜像
- 不需要联网拉取
- 安装后由 `cmd/install_callback` 自动 `docker load`
- 点开直接用

> 提示：飞牛官方 `fnpack` 有 Linux 版（`fnpack-1.2.3-linux-amd64` / `linux-arm64`），
> 所以 NAS 本地就能完成打包，不再需要把 tar 拷到 Windows。

### 做法 B：用 GitHub Actions 构建到 GHCR

仓库里已有 `.github/workflows/docker.yml`，推代码到 `main` 就会自动构建多架构镜像并推送：

```
ghcr.io/<你的GitHub用户名>/kaycftunnle:latest
```

**首次使用要做两件事：**

1. **让包可公开拉取**（否则 NAS 要 `docker login`）
   GitHub → 你的个人主页 → **Packages** → `kaycftunnle` → 右侧 **Package settings**
   → 底部 **Change visibility** → 选 **Public** → 输入包名确认

2. **触发一次构建**
   推到 `main` 分支，或到 **Actions** 页手动点 **Docker Multi-Arch Build → Run workflow**

构建完成后用 GHCR 镜像打包（`--image` 会自动把 `pull_policy` 设为 `always`）：

```bash
sh packaging/fnos/build-fpk.sh --image ghcr.io/<你的用户名>/kaycftunnle:latest
```

装包时飞牛会自动 `docker pull` 这个镜像。

> **NAS 拉不动 ghcr.io 怎么办？**
> 在 NAS 上试一下：`docker pull ghcr.io/<用户名>/kaycftunnle:latest`
> 超时就改用做法 C（NAS 本地构建），或给 NAS 的 Docker 配置代理。

### 做法 C：在 NAS 上一键就绪（fix-image.sh）

把项目源码放到 NAS（例如 `/vol1/1000/cftun-panel`），在**项目根目录**执行：

```bash
sudo sh fix-image.sh
```

它按这个顺序自动处理，**能用改名就不构建**：

1. 列出 NAS 上所有 `kay` 相关镜像
2. 目标 `kaycftunnle:latest` 已存在 → 直接结束
3. 有同类镜像（`kay-cftunnle:latest`、`cftun-panel-kay-cftunnle:latest` 等）
   → 自动 `docker tag` 改名，**几秒钟完成，原镜像保留**
4. 实在没有 → 才 `docker build`（3–10 分钟），并做容器内健康检查

常用变体：

```bash
sudo sh fix-image.sh --list     # 只看现状，不改动任何东西
sudo sh fix-image.sh --build    # 强制重新构建
```

> 之前有人反馈「明明有镜像却装不上」，几乎都是**镜像名差一个连字符**
> （`kay-cftunnle` vs `kaycftunnle`）。这个脚本会自动识别，不用你手动比对。

### 做法 D：用 build-on-nas.sh 精细控制

```bash
sudo sh build-on-nas.sh                              # 构建
sudo sh build-on-nas.sh --check                      # 只看现状
sudo sh build-on-nas.sh --retag kay-cftunnle:latest  # 指定旧名改名
```

### 做法 E：在有 Docker 的电脑上构建并一步打包

如果你的电脑有 Docker（Docker Desktop / Linux Docker），在项目根目录执行：

```bash
sh packaging/fnos/build-offline.sh
```

这条命令会：构建镜像 → 导出 tar → 自动调用 `build-fpk.sh` 打成内嵌镜像的 fpk，
产物直接到 `dist/kaycftunnle-1.0.0.fpk`（约 200–300 MB），**最省事**。

国内网络拉不动 Docker Hub 时，编辑脚本或临时导出镜像源：

```bash
# 手动分步，可换源
PY_BASE_IMAGE=docker.m.daocloud.io/library/python:3.13-slim \
CF_IMAGE=docker.m.daocloud.io/cloudflare/cloudflared:latest \
sh packaging/fnos/build-offline.sh
```

或自己构建后导出：

```bash
# 标准网络
docker build -t kaycftunnle:latest .

# 国内网络拉不动 Docker Hub 时，换镜像源
docker build \
  --build-arg PY_BASE_IMAGE=docker.m.daocloud.io/library/python:3.13-slim \
  --build-arg CF_IMAGE=docker.m.daocloud.io/cloudflare/cloudflared:latest \
  -t kaycftunnle:latest .

# 导出并拷到 NAS
docker save kaycftunnle:latest -o kaycftunnle.tar
# NAS 上：
docker load -i kaycftunnle.tar
```

镜像特点：
- 基于 `python:3.13-slim`，**零第三方 Python 依赖**（只用标准库）
- `cloudflared` 二进制直接从前一阶段 `COPY` 进来，不依赖 GitHub 下载
- 构建期会断言 `server.py` / `cf.py` / `static/index.html` 存在并做语法检查，
  缺文件时构建直接失败，不会出现「构建成功但启动报 ImportError」

构建完验证一下：

```bash
docker image ls | grep kaycftunnle     # 应能看到 kaycftunnle:latest
```

## 三、打成 fpk

```bash
sh packaging/fnos/build-fpk.sh
```

脚本会自动：
1. 找 `fnpack`（没有就从 `static2.fnnas.com` 下载 1.2.3 到 `.fnpack/`）
2. 把 `packaging/fnos/` 复制到 `.fpk-build/`
3. 检测到本地有 `kaycftunnle:latest` 时 `docker save` 塞进包内 `app/docker/image.tar`
4. 按镜像名自动设置拉取策略：
   - 名字带 `/`（如 `ghcr.io/user/kaycftunnle`）→ `pull_policy: always`
   - 纯本地名 → `pull_policy: never`
5. 校验必需文件与 JSON 合法性
6. 调 `fnpack build`，产物移到 `dist/kaycftunnle-<版本>.fpk`

参数：

```bash
sh build-fpk.sh                                     # 本地镜像，不拉取
sh build-fpk.sh --tar kaycftunnle.tar               # 使用现成的镜像 tar 内嵌
sh build-fpk.sh --image ghcr.io/you/kaycftunnle:latest   # 远程镜像，安装时自动拉
sh build-fpk.sh --no-embed                          # 不内嵌镜像
sh build-fpk.sh --no-image                          # 不动镜像，仅打骨架（调试用）
sh build-fpk.sh ... --license-url https://9ky.us.ci # 把卖家授权服务地址打进包里
```

`--license-url` 会把它写进 compose 的 `KAY_LICENSE_URL`。这样买家装完直接就是「已配置授权服务」：
激活页不再出现地址栏，在线卡密粘贴即用；离线批量码也在激活当场向服务端报到、完成设备绑定，
台账立刻显示买家机器码。不填这个参数时，买家要自己展开「授权服务地址」填一次（只用离线码的可以一直不填，
代价是这张码无法远程吊销）。

## 四、安装

**前提：镜像能拿到** —— 要么本地已有（`docker image ls | grep kaycftunnle`），
要么用 `--image` 指定了可拉取的远程镜像。

飞牛桌面 → 应用中心 → 右上角「手动安装」→ 选 `kaycftunnle-1.0.0.fpk`。

安装后：

- 桌面出现 **Kay-cftunnle** 图标，点开即进入面板（**无登录密码**，`no_auth_run=true`）
- 默认端口 **8567**，可在应用设置里改
- 数据目录：`/vol1/@appdata/kaycftunnle/`
  - `data/` → 容器 `/app/data`（`workbench.json`、SQLite）
  - `runtime/` → 容器 `/app/runtime`（cloudflared 二进制与日志）
- 升级/重装不会清空数据目录

## 五、包结构（便于排查）

```
kaycftunnle-1.0.0.fpk
├── manifest                 # 应用元信息（appname/version/端口/changelog）
├── ICON.PNG / ICON_256.PNG  # 64 / 256 图标
├── cmd/
│   ├── main                 # start / stop / status（0=成功 3=未运行）
│   ├── install_callback     # 建数据目录、写 .env、docker load 镜像
│   ├── uninstall_callback   # compose down + 兜底删容器，保留数据
│   └── *_init / *_callback  # 占位
├── config/
│   ├── privilege            # run-as: package
│   └── resource             # docker-project 声明
├── wizard/
└── app.tgz
    ├── docker/
    │   ├── docker-compose.yaml
    │   ├── env.default      # 构建时写入的镜像名
    │   ├── .env             # 安装时由 install_callback 生成（端口/数据目录/镜像名）
    │   ├── image.tar        # 仅内嵌模式存在
    │   └── IMPORT_IMAGE.txt # 未内嵌时附带的导入指引
    ├── ui/
    │   ├── config           # 桌面图标入口（url 类型，端口 8567）
    │   └── images/icon_{64,256}.png
    └── config/
        ├── privilege
        └── resource
```

解包检查：

```bash
tar -tzf dist/kaycftunnle-1.0.0.fpk          # 外层
tar -xzOf dist/kaycftunnle-1.0.0.fpk app.tgz | tar -tzf -   # 内层
```

## 六、常见问题

**安装时弹窗报 `Image ... Error Get "https://registry-1.docker.io/v2/": context deadline exceeded`**
→ 这是**镜像不在 NAS 本地、且被当成公网镜像去拉取**导致的（详见第一节）。
   按下面的「两条出路」任选一条就能解决。

**安装成功但点开是空白 / 502**
→ 容器没起来。NAS 终端执行 `docker logs kaycftunnle --tail 50`。
最常见原因是镜像不存在：`docker image ls | grep kaycftunnle` 无输出。

**提示端口占用**
→ 应用设置里改端口，或停掉占用 8567 的服务。`cmd/install_callback` 会把端口写进 `.env`，重启应用即生效。

**想重置面板数据**
→ `docker compose down` 后删除 `/vol1/@appdata/kaycftunnle/data/workbench.json`，下次启动会重新播种默认配置（`admin / 123456`）。

**`fnpack` 下载失败**
→ 手动下载 <https://static2.fnnas.com/fnpack/fnpack-1.2.3-windows-amd64>，
丢到项目根的 `.fnpack/` 并重命名为 `fnpack.exe`。

**包图标不对**
→ 图标由 `make_icons.py` 纯标准库生成，改完重跑 `python make_icons.py` 再打包。

## 七、按报错对号入座

### 报 `No such image: kaycftunnle:latest`

镜像不在 NAS 本地。一条命令搞定：

```bash
cd /你的项目目录
sudo sh fix-image.sh
```

它会自动找同类镜像改名（几秒），没有才构建。

### 报 `registry-1.docker.io ... context deadline exceeded`

镜像名被当成公网镜像去拉了。用**最新打出来的包**（`pull_policy: never`）即可，
不会再触发拉取。仍出现说明装的是旧包，重新 `sh packaging/fnos/build-fpk.sh`。

### 镜像名差了连字符

这是最容易踩的坑：

```
kay-cftunnle:latest   ← 有连字符
kaycftunnle:latest    ← 无连字符（fpk 要求的名字）
```

`build: .` 自动生成的镜像名取决于目录名与服务名的组合，很容易和预期不一致。
**不要凭记忆判断**，一律以 `docker image ls` 的实际输出为准。
或者直接用 `fix-image.sh`，它替你比对。

### 装完点开是空白 / 502

```bash
docker ps -a | grep kaycftunnle        # 看容器是否在跑
docker logs kaycftunnle --tail 50      # 看具体报错
```

最常见还是镜像问题或端口 8567 被占用。

### 重启 NAS 后面板没自启 / 应用中心报「启动失败」

两件事叠在一起：

1. fnOS 的应用自启经常抢在 Docker 守护进程前面跑，那一次 `docker compose up` 连不上
   daemon，而它**不重试**，界面就停在失败态。
2. 旧的 `cmd/main stop` 执行的是 `compose down`（容器对象被删），所以 Docker 也没办法
   在开机时替你把面板拉回来——只能等 fnOS 那次可能失败的自启。

`1.7.0-src-test6` 起改成：`cmd/main` 最多等 Docker 就绪 60 秒并重试三次；「停止」只停不删；
compose 的 `restart` 由 `unless-stopped` 改成 `always`，开机由 Docker 自己拉起面板。
副作用要知道：应用中心点「停止」后如果重启 NAS，面板会自己回来；要一直停就在
Docker/1Panel 里把该容器的重启策略改回 `unless-stopped`。

面板代码里还有一处同源的坑：以前开机是**先**打 Cloudflare API 取隧道令牌（单次 15 秒超时、
可能连着好几个请求）**再**监听 8567，网络没就绪时端口迟迟不出现，fnOS 的端口检测就判启动失败。
现在先绑端口，自动连接放到后台线程（实测 `auto_connect` 卡住 20 秒时端口仍能在 0.5 秒内就绪）。

自查：

```bash
docker inspect -f '{{.HostConfig.RestartPolicy.Name}} {{.State.Status}}' kaycftunnle
journalctl -b | grep -i kaycftunnle | tail -30
```

### 想彻底免掉「先构建」这一步

出一个内嵌镜像的包（约 200–300MB），装完开箱即用，适合分发给别人：

```bash
# 需要一台装了 Docker 的机器
sh packaging/fnos/build-offline.sh
```

脚本会构建镜像 → 导出 tar → 自动塞进 fpk。装到 NAS 上由 `cmd/install_callback`
自动 `docker load`，全程不需要联网。

> 注意：生成当前这个 67KB 包的环境没有 Docker，所以 `dist/` 里是轻量版。
