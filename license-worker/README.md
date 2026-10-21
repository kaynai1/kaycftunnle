# Kay-cftunnle 授权服务

Cloudflare Workers + KV 实现的授权服务，两种激活方式共用一个 Worker：

- **在线卡密** `KAY-XXXX-XXXX-XXXX`：一码一机、永久授权、可查机器码、可吊销、可解绑换机。
- **离线授权码** `KAYO-…`：Ed25519 签名，买家网络连不上 Cloudflare 也能激活；联网时向 Worker 报到，可远程吊销。

## 一、部署（约 5 分钟）

```bash
cd license-worker
npm install

# 1. 登录 Cloudflare
npx wrangler login

# 2. 创建 KV 命名空间，复制返回的 id
npx wrangler kv namespace create LICENSES

# 3. 把 id 填进 wrangler.toml 的 REPLACE_WITH_KV_NAMESPACE_ID

# 4. 设置管理员密钥（自己生成一串足够长的随机值）
#    PowerShell: $env:ADMIN='...'; npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put ADMIN_TOKEN

# 5. 部署，记下输出的 Worker 域名（形如 https://kay-license.<你的子域>.workers.dev）
npx wrangler deploy

# 6. 强烈建议：给 Worker 绑一个自定义域名
#    Cloudflare 控制台 → Workers 和 Pages → kay-license → 设置 → 域名 → 添加
#    *.workers.dev 在不少网络（含国内宽带）访问不通，买家激活会失败；
#    绑好自己的域名后，下面所有 <你的授权域名> 都填它

# 7. 每次 deploy 之后都要验一次令牌（见文末「部署后排错」）
curl -H "Authorization: Bearer <ADMIN_TOKEN>" https://<你的授权域名>/admin/licenses?limit=1
curl -H "Authorization: Bearer <ISSUE_TOKEN>" https://<你的授权域名>/admin/licenses?limit=1
```

> `ADMIN_TOKEN` 只用于管理卡密，绝不能填进面板，也不要发给买家。

只卖在线卡密的话，到这里就够了。要发离线授权码，再继续第二节。

## 二、离线授权怎么运作

私钥从不落地在任何服务器上，只以口令加密的密文存在 Worker 密钥里：

```
node tools/keygen.mjs            # 生成 32 字节私钥 → PBKDF2(31万次)+AES-256-GCM 密文
                                 # 口令只记在自己脑子里，密文写 tools/offline-key.json
npx wrangler secret put KEY_BLOB < tools/offline-key.json   # 上传密文
npx wrangler secret put ISSUE_TOKEN                          # 发卡台令牌（与 ADMIN_TOKEN 分开）
npx wrangler deploy
```

签发时（网页发卡台或 `tools/issue.mjs`）：

1. 浏览器/本机用 **口令 + salt** 跑 PBKDF2，得到 AES 密钥；
2. 只有这把派生密钥交给 Worker（口令从不上网），Worker 做一次 AES-GCM 解密拿到私钥，签完即弃；
3. 授权码 = 22 字节载荷（机器码 / 编号 / 签发与到期时间）+ 64 字节 Ed25519 签名，Base32 分组后约 170 个字符。

买家面板用内置公钥本地验签，**不联网也能激活**；填了授权服务地址时，激活当场向 `/offline/report` 报到一次，之后每 6 小时一次，服务端回 `revoked: true`（已吊销）或 `device_mismatch: true`（批量码已被别的设备认领）才锁定。连不上、编号不在台账里都不影响使用——离线授权是“尽力吊销”，不是强制在线。

**公钥必须打进面板**：部署完打开 `https://<worker 域名>/issue`，用口令解锁后页面会回显对应公钥，复制成 `OFFLINE_PUBLIC_KEY = "…"` 写进面板 `license.py`，再重新构建镜像。公钥为空时面板一律拒绝离线授权码。

有效期默认 365 天（`--days` / 页面可改，`--permanent` 永久）。到期由本地签名里的时间戳判定，改系统时间会被面板的高水位时间戳挡下。

## 三、本地签发（不依赖网页）

```bash
node tools/issue.mjs --machine NAS-2H22-RKM4-RZ6N --note "闲鱼订单 20261021"
node tools/issue.mjs --file machines.txt --days 365 --out codes.txt
node tools/issue.mjs --machine NAS-XXXX-XXXX-XXXX --permanent
node tools/issue.mjs --list            # 查看签发台账 tools/issued.json
```

台账、私钥密文、导出的码都在 `.gitignore` 里，别提交、别发给买家。
本地签发不写 Worker 台账，这类码报到时服务端回 `known: false`（照常可用，但**无法远程吊销**）；要能吊销就统一用网页发卡台签发。

## 四、网页发卡台 `/issue`

Worker 自带一个单文件页面（无构建、无框架）：<https://<你的授权域名>/issue>，顶上两个标签对应两种授权：

**「在线卡密」— 20 位短码**：顶栏填发卡令牌 → 填数量和备注 → 一批出 `KAY-XXXX-XXXX-XXXX`，
不用先收买家机器码，他首次激活时自动绑定本机。下方卡密台账能按卡密 / 买家设备 / 备注搜索，
显示绑定机器码、最近校验时间与来源 IP，并提供「解绑」（换机）和「吊销 / 恢复」。

**「离线授权码」— 长码 `KAYO-…`**：买家连不上授权服务时用。填 `ISSUE_TOKEN` + 私钥口令 → 解锁 →
一行一个机器码 → 生成，可复制 / 导出 CSV；下方台账来自 KV，能搜、能吊销、能恢复，并显示每台设备最近报到时间与来源 IP。

**批量预生成（挂闲鱼自动发货用这个）**：勾「不绑定机器码（批量预生成）」后填数量（一次最多 100 张），
不用等买家发机器码，直接出一批码。买家激活时这台机器会被自动绑定，台账「买家设备」列显示他的机器码，
别人再拿同一张码会被锁；买家换机就点那一行的「解绑」，新设备下次报到自动绑上（写死机器码的老码没有解绑按钮）。
页面 `noindex` + CSP，令牌只存在内存（勾选“记住”才写 sessionStorage），口令任何时候都不出浏览器。

> 发卡令牌 `ISSUE_TOKEN` 现在同时能管在线卡密台账和离线台账，所以卖家日常只用这一个令牌就够；
> `ADMIN_TOKEN` 留给命令行 `admin.mjs` 和应急。

本地先看效果（内存 KV、每次启动生成临时私钥）：

```bash
node license-worker/dev-server.mjs 8788   # 打开 http://127.0.0.1:8788/issue
```

## 五、管理在线卡密（命令行）

网页发卡台的「在线卡密」标签做的是同一件事；命令行适合批量出卡和不在电脑前用脚本兜底。
CLI 默认只依赖 Node 18+ 自带的 `fetch`：

```powershell
$env:KAY_LICENSE_URL="https://<你的授权域名>"
$env:KAY_LICENSE_ADMIN_TOKEN="你的 ADMIN_TOKEN"

node admin.mjs new --count 5 --note "闲鱼订单 20261021"
node admin.mjs list
node admin.mjs show   KAY-XXXX-XXXX-XXXX
node admin.mjs revoke KAY-XXXX-XXXX-XXXX   # 吊销：面板下次校验后锁定并停止连接器
node admin.mjs restore KAY-XXXX-XXXX-XXXX  # 恢复
node admin.mjs unbind KAY-XXXX-XXXX-XXXX   # 解绑：让买家换一台 NAS 重新激活
```

如果这台电脑直连 `*.workers.dev` 不通（报 `无法连接授权服务：fetch failed`），再设一个代理变量走本地代理，CLI 会自动通过它发请求：

```powershell
$env:KAY_LICENSE_PROXY="http://127.0.0.1:7897"   # 需要 npm install 装上 undici
```

`list` 会显示卡密状态、绑定机器码、最近校验时间和备注。买家报“换机器了”时，先 `unbind`，再用原卡密在新机器上激活。
离线授权码换机看签发方式：**批量预生成的码**在发卡台台账点「解绑」，新设备下次报到自动绑上；
**签发时写死机器码的码**签名里改不了，没有解绑，只能重新签发一张（旧码在发卡台吊销）。

## 六、面板端配置

面板首次打开会跳到激活页，页顶有两个并列的标签：

**在线卡密**（默认）——20 位短码，买家 NAS 要能访问 <https://<你的授权域名>>：

1. **授权服务地址**：上面的 `https://<你的授权域名>`（只需填一次）
2. **卡密**：`KAY-XXXX-XXXX-XXXX`，卖家批量出卡、买家直接粘贴，不需要先报机器码

**离线授权码**——买家网络连不上 Cloudflare 时用：

1. **批量卖**：在发卡台勾「不绑定机器码（批量预生成）」出码，把码挂上自动发货，买家拿到直接粘贴激活；
   激活后他的机器码出现在台账「买家设备」列，同一张码别人再用会被锁
2. **一对一卖**：买家在面板「设置 → 授权状态」里复制机器码 `NAS-XXXX-XXXX-XXXX` 发给你，
   你在发卡台用这个机器码签发一张 `KAYO-…` 授权码发回去
3. 买家粘贴授权码即可激活，全程不需要能访问 Worker；填了服务地址才会报到（激活当场一次，之后每 6 小时一次）

也可以跳过手填，在 Docker Compose 里设置：

```yaml
environment:
  KAY_LICENSE_URL: "https://<你的授权域名>"
  KAY_OFFLINE_GRACE_DAYS: "7"
```

在线卡密每 6 小时校验一次；断网时进入宽限期（默认 7 天），宽限期内功能照常；被吊销后立即锁定面板并停止 cloudflared。
离线授权码本地验签即可长期使用，只有到期、换机或报到时被服务端标记吊销才会锁定。

**授权服务地址不会出现在浏览器里**：面板前端只调用自己 `/api/license/*`，由面板后端转发到 Worker；`/api/license/status` 只返回 `server_configured: true/false`，激活页默认隐藏该字段（点「更换授权服务地址」才会出现输入框）。买家在浏览器控制台、页面源码里都看不到 Worker 域名，只有 NAS 上的 `data/license.json` 和部署环境变量里有。

## 七、暴露面与防刷

Worker 域名一旦被猜到，任何人都能调用 `/activate`、`/verify`，所以要按“公网可达接口”来设防：

| 风险 | 现有防护 | 建议加固（Cloudflare 控制台） |
| --- | --- | --- |
| 猜卡密 | 60 bit 随机（36 字符表），穷举不现实；格式不符直接 400 | 无需额外处理 |
| 脚本刷接口 / 消耗 KV 与请求配额 | Worker 内置按 IP 限流：公开接口 60 次/分钟、管理接口 30 次/分钟，超出返回 429 | 再加一条 **Security → WAF → Rate Limiting Rules**：对 `/activate`、`/verify` 每 IP 10 次/分钟，动作 Block 或 Managed Challenge（免费版可建 1 条） |
| 猜 `ADMIN_TOKEN` | 常数时间比较；未配置令牌直接 503；管理接口另有 30 次/分钟限流 | 令牌用 32 字节以上随机值；只放在 `wrangler secret`，不要写进代码或 compose |
| 拿到 `KEY_BLOB` 就能签发 | 密文是 PBKDF2-SHA256(31 万次) + AES-256-GCM 包裹，没有口令解不开；口令不进浏览器地址栏、不上网、KV 里也没有 | 口令与 `ISSUE_TOKEN` 分开保管；怀疑泄露时 `keygen --force` 重新生成，重新 `secret put KEY_BLOB` 并换面板公钥 |
| 刷 `/offline/issue` 签码 | 必须先有 `ISSUE_TOKEN`，再要有能解开 `KEY_BLOB` 的派生密钥，两者缺一直接 401/400；另有 5 次/分钟限流 | 给 `/offline/*`、`/issue` 再加一条 WAF 速率规则；发卡时用完就关页面 |
| 洪水 / 扫描 | 走 Cloudflare 边缘，源站不暴露；响应统一 `no-store`、`nosniff`、`X-Frame-Options: DENY`；`/issue` 另有 CSP 与 `noindex` | 开启 **Bot Fight Mode**；给 Worker 绑自定义域名并只保留需要的路由；必要时 Security → Settings 里打开 Under Attack |
| 配额被打满导致误伤 | 免费档 Workers 每天 10 万次请求，超了只报错、**不会自动扣费**（付费档请在 Billing 设消费上限） | 面板正常负载约每台每天 4 次校验，几十台设备远低于上限 |

补充：

- Worker 不返回 CORS 头，浏览器脚本跨域调用拿不到响应；面板是服务端直连，不受影响。
- 想再收一层，可给 `/activate`、`/verify` 加自定义请求头密钥（面板侧写死或环境变量），但这层只是提高门槛，真正的边界仍是卡密与 `ADMIN_TOKEN`。
- 排查异常时看 Worker 的 **Logs**：记录里带 `CF-Connecting-IP`、激活时间与绑定机器码，能定位是哪台设备或哪个来源在刷。

## 八、接口

公开：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查，`offline_ready` 表示 KEY_BLOB 是否已配置 |
| POST | `/activate` | `{code, machine_code}` 激活并绑定 |
| POST | `/verify` | `{code, machine_code}` 校验绑定与吊销状态 |
| POST | `/offline/report` | `{serial, machine_code}` 离线授权报到，回 `{revoked, device_mismatch, bound, reported_at, expires_at}`；批量码首次报到即绑定该设备 |
| GET | `/issue` | 网页发卡台（令牌在页面里填，不走 URL 参数） |

发卡（`Authorization: Bearer <ISSUE_TOKEN>`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/offline/params` | 返回 salt 与迭代次数，供浏览器派生 AES 密钥（不含密文） |
| POST | `/offline/issue` | `{derived_key, machines[] \| any_machine + count, days \| permanent, note}` 批量签发（不绑机器时 `count` 最多 100）；`{derived_key, dry_run:true}` 只自检口令并回显公钥 |

管理（`ADMIN_TOKEN` 或 `ISSUE_TOKEN` 均可，发卡台只用后面这一个）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/admin/licenses` | `{count, note}` 批量生成 20 位短码 |
| GET | `/admin/licenses?q=` | 列表 / 搜索（卡密、买家机器码、备注） |
| GET | `/admin/licenses/:code` | 详情（含完整机器码） |
| POST | `/admin/licenses/:code/revoke` | `{revoked:true/false}` 吊销 / 恢复 |
| POST | `/admin/licenses/:code/unbind` | 解绑设备 |
| GET | `/admin/offline?q=&limit=` | 离线签发台账 + 摘要（共签发 / 已报到 / 已吊销 / 30 天内到期） |
| GET | `/admin/offline/:serial` | 单条详情（含完整机器码、报到 IP） |
| POST | `/admin/offline/:serial/revoke` | `{revoked:true/false}` 吊销 / 恢复 |
| POST | `/admin/offline/:serial/unbind` | 解绑批量码的买家设备（写死机器码的码返回 409，需重签） |

错误统一返回 `{ok:false, reason, error}`，`reason` 便于面板区分：

- `invalid_code` / `invalid_machine` / `invalid_serial` — 格式错误
- `not_found` — 卡密不存在
- `revoked` — 已吊销
- `device_mismatch` — 已绑定其他设备
- `not_activated` — 尚未激活
- `unauthorized` — 令牌错误
- `key_unwrap_failed` — 私钥口令不对，解不开 KEY_BLOB
- `issue_not_configured` / `key_not_configured` / `kv_not_configured` — 服务端密钥或 KV 未配置

## 九、测试

```bash
npm test
```

测试用内存 KV 跑完整流程，不需要 Cloudflare 账号：在线卡密的生成/激活/换绑/吊销/限流，
离线授权的令牌校验、口令解不开、批量签发、永久与不绑定机器码、报到与远程吊销、编号段分配、`/issue` 页面响应头，
并用纯 JS Ed25519 验签确认签出的码签名有效。

面板侧另有 `python -m unittest discover -s tests`（含用面板 Python 验签器校验 Worker 签发的码）。

## 十、说明

- 卡密为 60 bit 随机（`KAY-` + 12 位 Crockford Base32），不可枚举。
- **两种授权按买家的网络选，不要都发**：20 位短码（在线卡密）里只装得下一个随机编号，真伪要靠授权服务当场判定，所以买家 NAS 必须能访问你的域名；离线授权码长（170 个字符）是因为整段装了 64 字节 Ed25519 签名，面板拿内置公钥就能本地判真伪，一个包都不用在联网。想把这个签名压到 20 位，只能改成对称密钥并把密钥放进面板——买家从镜像里提出来就能自己签码，等于没有授权系统。
- 免费版 KV 每天 10 万次读、1000 次写；每台设备每天约 4 次校验写入，几十台设备毫无压力。
- 激活采用“先读后写”，极端并发下同一张未使用卡密被两台机器同时激活时，后写入者生效，另一台会在校验时被拒绝。正常销售场景不会遇到。
- 删除 KV 命名空间会丢失全部卡密记录；建议定期用 `list` 导出留档。
- 离线授权编号 = 签发时刻的 Unix 秒（`meta:offline_seq` 记高水位，批量签发顺序 +1），4 字节够用；网页发卡台与 `tools/issue.mjs` 同源计时，同一秒各自签发时会撞号的概率极低，且 Worker 侧会检查编号是否已被占用并自动让开一段。
- 只在本机签发过的码不在 KV 台账里，报到时回 `known: false`，面板照常使用，但无法远程吊销。要保留吊销能力，统一用 `/issue` 发卡台签发。
- 换机能不能解绑看签发方式：批量预生成的码由服务端记绑定，发卡台点「解绑」即可让新设备接管；签发时写死机器码的码绑在签名里，改不了，只能重签一张。
- 免费版 KV 每天 1000 次写：一次批量签发写 N 条 + 1 次编号高水位；每台离线设备每天最多 4 次报到，且同机短时间重复报到不再写 KV。

## 十一、部署后排错

`wrangler deploy` 不会显示密钥有没有跟着走，实测遇到过部署后 `ISSUE_TOKEN` 突然 401、
`ADMIN_TOKEN` 却正常（`wrangler secret list` 仍然列出三个密钥，看不出区别）。所以每次部署完
先跑一遍上面第 7 步的两条 `curl`，任意一条不是 200 就直接重传对应密钥：

```bash
printf '%s' "<ISSUE_TOKEN>" | npx wrangler secret put ISSUE_TOKEN
printf '%s' "<ADMIN_TOKEN>"  | npx wrangler secret put ADMIN_TOKEN
```

`wrangler secret put` 必须从本目录执行（要在 `wrangler.toml` 里找 Worker 名），
且非交互输入时值用管道喂进去、结尾别带换行。
发卡台网页登录用的是 `ISSUE_TOKEN`，它 401 时买家和卖家都会卡在「令牌无效」。
