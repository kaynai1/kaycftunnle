// SPDX-License-Identifier: MIT
// 发卡台：由 Worker 直接返回的单文件页面，无构建、无框架。
// 口令只在浏览器里跑 PBKDF2，交给 Worker 的是派生出的 AES 密钥——口令从不上网。
export const ISSUE_CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Kay-cftunnle 发卡台</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23FF6B35'/%3E%3Cpath d='M6 27V15a10 10 0 0 1 20 0v12h-5V15a5 5 0 0 0-10 0v12H6Z' fill='%231C1917'/%3E%3C/svg%3E">
<style>
:root{
  --font-ui:'PingFang SC','Microsoft YaHei','Segoe UI',system-ui,-apple-system,sans-serif;
  --font-num:ui-monospace,'Cascadia Mono',Consolas,'SFMono-Regular','PingFang SC',monospace;
  --page:#171410;--surface:#221d18;--soft:#2a241e;--raised:#332b24;--hover:#3a2c20;
  --border:#3a332b;--border-strong:#57503f;--text:#f5efe8;--text2:#d6cec3;--muted:#a8a09a;--subtle:#857d75;
  --accent:#FF7A47;--accent-text:#FF8C5A;--accent-bg:#3a2a20;--accent-border:#5a4030;--on-accent:#1c1917;
  --ok-bg:#0f2e24;--ok-bd:#1c5140;--ok-tx:#4ade80;--warn-bg:#3a2e10;--warn-bd:#6b5416;--warn-tx:#fbbf24;
  --bad-bg:#3a1a1e;--bad-bd:#5c2730;--bad-tx:#fb7185;
  --r-card:18px;--r-sm:10px;--r-pill:9999px;
  --sh:0 1px 2px rgba(0,0,0,.3),0 10px 30px rgba(0,0,0,.28);
  --ring:0 0 0 3px rgba(255,138,90,.2);
}
html[data-theme=light]{
  color-scheme:light;
  --page:#f7f6f3;--surface:#fff;--soft:#faf8f5;--raised:#f1ede7;--hover:#fdf1e9;
  --border:#e8e2d9;--border-strong:#d3c9bb;--text:#1c1917;--text2:#44403c;--muted:#78716c;--subtle:#a8a29e;
  --accent:#FF6B35;--accent-text:#C24A17;--accent-bg:#FFF3EC;--accent-border:#FFD6BC;--on-accent:#1c1917;
  --ok-bg:#ecfdf5;--ok-bd:#a7f3d0;--ok-tx:#047857;--warn-bg:#fffbeb;--warn-bd:#fde68a;--warn-tx:#b45309;
  --bad-bg:#fff1f2;--bad-bd:#fecdd3;--bad-tx:#be123c;
  --sh:0 1px 2px rgba(28,25,23,.05),0 10px 28px rgba(28,25,23,.07);
  --ring:0 0 0 3px rgba(255,107,53,.16);
}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--text);font:400 14px/1.55 var(--font-ui);
  background-image:radial-gradient(1200px 320px at 50% -120px,rgba(255,122,71,.13),transparent 70%);}
header{position:sticky;top:0;z-index:9;background:color-mix(in srgb,var(--page) 88%,transparent);
  backdrop-filter:blur(10px);border-bottom:1px solid var(--border)}
.bar{max-width:1080px;margin:0 auto;padding:14px 22px;display:flex;align-items:center;gap:14px}
.mark{width:34px;height:34px;border-radius:11px;background:var(--accent);color:var(--on-accent);
  display:grid;place-items:center;font:800 17px var(--font-num);flex:0 0 auto}
h1{margin:0;font-size:16px;font-weight:700;letter-spacing:-.01em}
.sub{margin:1px 0 0;font-size:11.5px;color:var(--muted)}
.spacer{flex:1 1 auto}
.pill{display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:var(--r-pill);
  border:1px solid var(--border);background:var(--soft);font-size:11.5px;color:var(--muted)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--subtle);flex:0 0 auto}
.pill.ok .dot{background:var(--ok-tx)}.pill.bad .dot{background:var(--bad-tx)}.pill.wait .dot{background:var(--warn-tx);animation:bl 1.2s infinite}
@keyframes bl{50%{opacity:.25}}
main{max-width:1080px;margin:0 auto;padding:26px 22px 64px;display:grid;gap:18px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-card);
  box-shadow:var(--sh);padding:20px 22px;position:relative;overflow:hidden}
.card:before{content:"";position:absolute;inset:0 0 auto 0;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.16),transparent)}
.ct{display:flex;align-items:center;gap:10px;margin:0 0 4px}
.step{width:22px;height:22px;border-radius:7px;background:var(--accent-bg);border:1px solid var(--accent-border);
  color:var(--accent-text);display:grid;place-items:center;font:700 11.5px var(--font-num);flex:0 0 auto}
h2{margin:0;font-size:14.5px;font-weight:700}
.hint{margin:0 0 16px;font-size:12px;color:var(--muted);line-height:1.6}
.grid{display:grid;gap:14px;grid-template-columns:1fr 1fr}
.field{display:grid;gap:6px}
label{font-size:11.5px;font-weight:600;color:var(--text2);letter-spacing:.01em}
input[type=text],input[type=password],input[type=number],textarea,select{
  width:100%;padding:9px 11px;border-radius:var(--r-sm);border:1px solid var(--border);
  background:var(--soft);color:var(--text);font:400 13px var(--font-ui);outline:none;transition:border-color .16s,box-shadow .16s}
input:focus,textarea:focus,select:focus{border-color:var(--accent);box-shadow:var(--ring)}
textarea{font:400 12.5px/1.7 var(--font-num);resize:vertical;min-height:112px;word-break:break-all}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:16px}
button{display:inline-flex;align-items:center;gap:7px;padding:9px 16px;border-radius:var(--r-sm);
  border:1px solid var(--border);background:var(--raised);color:var(--text);font:600 12.5px var(--font-ui);
  cursor:pointer;transition:transform .12s,background .16s,border-color .16s}
button:hover:not(:disabled){background:var(--hover);border-color:var(--border-strong)}
button:active:not(:disabled){transform:translateY(1px)}
button:focus-visible{outline:none;box-shadow:var(--ring);border-color:var(--accent)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:700}
button.ghost{background:transparent}
button.sm{padding:5px 10px;font-size:11.5px;border-radius:8px}
button.danger{color:var(--bad-tx);border-color:var(--bad-bd);background:var(--bad-bg)}
button:disabled{opacity:.45;cursor:not-allowed}
.check{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--text2);cursor:pointer}
.check input{width:15px;height:15px;accent-color:var(--accent)}
.bar .tok{width:220px;padding:7px 11px;border-radius:var(--r-sm);border:1px solid var(--border);
  background:var(--soft);color:var(--text);font:400 12px var(--font-num);outline:none}
.bar .tok:focus{border-color:var(--accent);box-shadow:var(--ring)}
#rememberWrap{flex:0 0 auto}
.tabs{display:flex;gap:8px;padding:4px;border:1px solid var(--border);border-radius:var(--r-pill);
  background:var(--soft);width:max-content;max-width:100%;flex-wrap:wrap}
.tab{padding:8px 18px;border:0;border-radius:var(--r-pill);background:transparent;color:var(--muted);
  font:700 13px var(--font-ui);cursor:pointer;display:flex;flex-direction:column;align-items:flex-start;gap:1px;line-height:1.25}
.tab:hover:not(.on){color:var(--text)}
.tab.on{background:var(--accent);color:var(--on-accent)}
.tab .ts{font:600 10.5px var(--font-ui);opacity:.75}
.tab.on .ts{opacity:.85}
.note{margin-top:14px;padding:11px 13px;border-radius:var(--r-sm);font-size:12px;line-height:1.6;border:1px solid var(--border);background:var(--soft)}
.note.ok{border-color:var(--ok-bd);background:var(--ok-bg);color:var(--ok-tx)}
.note.bad{border-color:var(--bad-bd);background:var(--bad-bg);color:var(--bad-tx)}
.note.warn{border-color:var(--warn-bd);background:var(--warn-bg);color:var(--warn-tx)}
code,.mono{font-family:var(--font-num)}
.kv{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.kv span{font:600 11px var(--font-num);padding:4px 9px;border-radius:8px;background:var(--raised);color:var(--text2);border:1px solid var(--border)}
table{width:100%;border-collapse:collapse;margin-top:6px;font-size:12.5px}
th{text-align:left;font:600 11px var(--font-ui);color:var(--muted);padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
tr:last-child td{border-bottom:0}
tbody tr:hover{background:var(--hover)}
.code{font:400 11.5px/1.5 var(--font-num);color:var(--accent-text);word-break:break-all;max-width:330px}
.tag{font:700 10.5px var(--font-num);padding:3px 8px;border-radius:var(--r-pill);border:1px solid var(--ok-bd);background:var(--ok-bg);color:var(--ok-tx);white-space:nowrap}
.tag.off{border-color:var(--bad-bd);background:var(--bad-bg);color:var(--bad-tx)}
.tag.warn{border-color:var(--warn-bd);background:var(--warn-bg);color:var(--warn-tx)}
.tag.gray{border-color:var(--border);background:var(--raised);color:var(--muted)}
.sum{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}
.sum b{font:700 15px var(--font-num);display:block}
.sum i{font-style:normal;font-size:11px;color:var(--muted)}
.sum div{padding:8px 14px;border:1px solid var(--border);border-radius:12px;background:var(--soft);min-width:78px}
.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(14px);opacity:0;
  padding:10px 18px;border-radius:var(--r-pill);background:var(--text);color:var(--page);font-size:12.5px;font-weight:600;
  box-shadow:var(--sh);transition:opacity .2s,transform .2s;pointer-events:none;z-index:30}
.toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
.spin{width:13px;height:13px;border:2px solid color-mix(in srgb,var(--on-accent) 35%,transparent);
  border-top-color:var(--on-accent);border-radius:50%;animation:sp .7s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.empty{padding:22px;text-align:center;color:var(--subtle);font-size:12.5px;border:1px dashed var(--border);border-radius:12px;margin-top:12px}
.split{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
@media(max-width:760px){
  .grid{grid-template-columns:1fr}
  main{padding:18px 14px 56px}.bar{padding:12px 14px;gap:10px;flex-wrap:wrap}.card{padding:16px 14px}
  .bar .sub{display:none}
  .bar .mark{order:-1}
  .bar>div:nth-child(2){flex:1 1 60%}
  .bar .tok{flex:1 1 150px;width:auto}
  .tabs{width:100%}.tab{flex:1 1 auto;align-items:center;padding:8px 10px}
  .pill{font-size:11px;padding:4px 9px;white-space:nowrap}
  #search,#cardSearch{width:100%!important}
  thead{display:none}
  table,tbody,tr,td{display:block;width:100%}
  tbody tr{border:1px solid var(--border);border-radius:12px;padding:8px 10px;margin-bottom:10px;background:var(--soft)}
  td{border:0;padding:3px 0;display:flex;gap:10px;justify-content:space-between;align-items:flex-start}
  td:before{content:attr(data-l);font:600 11px var(--font-ui);color:var(--muted);flex:0 0 auto}
  .code{max-width:62%;text-align:right}
  .split{flex-direction:row;width:100%;justify-content:flex-end}
}
</style>
</head>
<body>
<header><div class="bar">
  <div class="mark">K</div>
  <div><h1>Kay-cftunnle 发卡台</h1><p class="sub">离线授权码与在线卡密 · 私钥仅以口令密文保存在 Workers 密钥里</p></div>
  <div class="spacer"></div>
  <input type="password" id="token" class="tok" autocomplete="off" spellcheck="false" placeholder="发卡令牌 ISSUE_TOKEN">
  <label class="check" id="rememberWrap"><input type="checkbox" id="remember">记住</label>
  <span class="pill wait" id="svc"><span class="dot"></span><span id="svcText">连接检查中…</span></span>
  <button class="ghost sm" id="themeBtn" type="button">浅色</button>
</div></header>
<main>
  <div class="tabs" role="tablist">
    <button class="tab on" id="tabOffline" type="button" role="tab">离线授权码<span class="ts">长码 · 买家不用联网</span></button>
    <button class="tab" id="tabOnline" type="button" role="tab">在线卡密<span class="ts">20 位短码 · 买家需能连授权服务</span></button>
  </div>
  <div id="paneOffline">
  <section class="card">
    <div class="ct"><span class="step">1</span><h2>解锁私钥</h2></div>
    <p class="hint">顶栏的发卡令牌（ISSUE_TOKEN）挡外人，私钥口令解私钥，是两样东西。口令只在本机做 PBKDF2，浏览器把派生出的密钥交给 Worker，密文与口令都不落地。</p>
    <div class="grid">
      <div class="field"><label for="pass">私钥口令</label><input type="password" id="pass" autocomplete="new-password" placeholder="keygen 时设的口令，至少 8 位"></div>
    </div>
    <div class="row">
      <button class="primary" id="unlockBtn" type="button"><span id="unlockText">解锁私钥</span></button>
      <span class="pill" id="unlockState"><span class="dot"></span>未解锁</span>
    </div>
    <div class="note warn" id="keyHint" hidden></div>
  </section>

  <section class="card">
    <div class="ct"><span class="step">2</span><h2>签发授权码</h2></div>
    <p class="hint">一行一个买家机器码（NAS-XXXX-XXXX-XXXX）。机器码在买家面板「设置 → 授权状态」里能直接看到。批量挂闲鱼就勾下面的「不绑定机器码」，买家首次激活时会自动绑上他那台机器，台账里能看到。</p>
    <div class="field"><label for="machines">机器码列表</label><textarea id="machines" spellcheck="false" placeholder="NAS-2H22-RKM4-RZ6N&#10;NAS-XXXX-XXXX-XXXX"></textarea></div>
    <div class="row">
      <div class="split">
        <div class="field" style="width:120px"><label for="days">有效期（天）</label><input type="number" id="days" value="365" min="1" max="3650"></div>
        <label class="check"><input type="checkbox" id="permanent">永久</label>
        <label class="check"><input type="checkbox" id="anyMachine">不绑定机器码（批量预生成）</label>
        <div class="field" id="countField" style="width:110px" hidden><label for="count">生成数量</label><input type="number" id="count" value="10" min="1" max="100"></div>
      </div>
    </div>
    <div class="grid" style="margin-top:14px">
      <div class="field"><label for="note">备注（订单号 / 买家昵称）</label><input type="text" id="note" maxlength="120" placeholder="闲鱼 2026-10-21 张三"></div>
      <div class="field"><label>&nbsp;</label><div class="row" style="margin:0"><button class="primary" id="issueBtn" type="button" disabled><span id="issueText">生成授权码</span></button><span class="mono" style="font-size:11.5px;color:var(--muted)" id="countText">0 张</span></div></div>
    </div>
  </section>

  <section class="card" id="resultCard" hidden>
    <div class="ct"><h2>本次签发</h2><div class="spacer"></div>
      <button class="sm" id="copyAllBtn" type="button">复制全部</button>
      <button class="sm" id="csvBtn" type="button">导出 CSV</button>
    </div>
    <div id="resultBody"></div>
  </section>

  <section class="card">
    <div class="ct"><span class="step">3</span><h2>签发台账</h2><div class="spacer"></div>
      <input type="text" id="search" placeholder="搜编号 / 机器码 / 备注" style="width:230px">
      <button class="sm" id="refreshBtn" type="button">刷新</button>
    </div>
    <p class="hint">面板每 6 小时向这里报到一次；吊销后买家面板下次报到即锁定。断网的机器不受影响，本地签名到期才算失效。不绑定机器码的批量码在买家激活时自动绑定，「买家设备」列显示他的机器码，换机点「解绑」。</p>
    <div class="sum" id="summary"></div>
    <div id="ledgerBody"><div class="empty">解锁后自动读取台账</div></div>
  </section>
  </div>

  <div id="paneOnline" hidden>
  <section class="card">
    <div class="ct"><span class="step">1</span><h2>批量生成卡密</h2></div>
    <p class="hint">形如 <code>KAY-XXXX-XXXX-XXXX</code> 的 20 位短码，直接发给买家就能用，不需要机器码：买家在面板「设置 → 授权状态」里填这一串，激活时自动绑定他那台设备。代价是买家联网时要能访问本授权服务，之后每 6 小时校验一次；完全断网的买家请用「离线授权码」标签的长码。</p>
    <div class="row" style="margin-top:0">
      <div class="split">
        <div class="field" style="width:120px"><label for="cardCount">生成数量</label><input type="number" id="cardCount" value="10" min="1" max="100"></div>
        <div class="field" style="flex:1 1 260px"><label for="cardNote">备注（订单号 / 买家昵称）</label><input type="text" id="cardNote" maxlength="120" placeholder="闲鱼 2026-10-21 张三"></div>
        <div class="field" style="align-self:end"><div class="row" style="margin:0"><button class="primary" id="cardBtn" type="button"><span id="cardText">生成卡密</span></button><span class="mono" style="font-size:11.5px;color:var(--muted)" id="cardCountText">10 张</span></div></div>
      </div>
    </div>
  </section>

  <section class="card" id="cardResultCard" hidden>
    <div class="ct"><h2>本次生成</h2><div class="spacer"></div>
      <button class="sm" id="copyCardsBtn" type="button">复制全部</button>
      <button class="sm" id="cardCsvBtn" type="button">导出 CSV</button>
    </div>
    <div id="cardResultBody"></div>
  </section>

  <section class="card">
    <div class="ct"><span class="step">2</span><h2>卡密台账</h2><div class="spacer"></div>
      <input type="text" id="cardSearch" placeholder="搜卡密 / 买家设备 / 备注" style="width:230px">
      <button class="sm" id="cardRefreshBtn" type="button">刷新</button>
    </div>
    <p class="hint">「买家设备」是买家首次激活时自动绑上的机器码，出现在面板「设置 → 授权状态」里。买家换机就点「解绑」，新设备下次校验自动绑上；「吊销」会让他的面板立即锁定。卡密一旦发出就是永久有效，除非你吊销它。</p>
    <div class="sum" id="cardSummary"></div>
    <div id="cardLedger"><div class="empty">填好顶栏令牌后点刷新</div></div>
  </section>
  </div>
</main>
<div class="toast" id="toast"></div>
<script>
var token="",derivedKey="",pubKey="",batch=[],ledgerLoaded=false;
var cardBatch=[],cards=[],cardLoaded=false,tab="offline";
function $(id){return document.getElementById(id)}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function toast(m){var t=$("toast");t.textContent=m;t.classList.add("on");clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove("on")},2200)}
function b64(v){var s=atob(v),a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return a}
function toB64(a){var s="";for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s)}
function dayText(ts){if(!ts)return"永久";var d=new Date(ts*1000),p=function(n){return(n<10?"0":"")+n};return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())}
function left(ts){if(!ts)return"";var n=Math.ceil((ts-Date.now()/1000)/86400);return n<=0?"已到期":n<=60?"剩 "+n+" 天":""}

async function api(path,opts){
  opts=opts||{};
  var h={};
  if(opts.token!==false&&token)h.Authorization="Bearer "+token;
  if(opts.body!==undefined)h["Content-Type"]="application/json";
  var r=await fetch(path,{method:opts.method||"GET",headers:h,body:opts.body===undefined?undefined:JSON.stringify(opts.body)});
  var d={};try{d=await r.json()}catch(e){}
  if(!r.ok||d.ok===false){var err=new Error(d.error||("HTTP "+r.status));err.status=r.status;err.reason=d.reason;throw err}
  return d
}

function setSvc(cls,text){var p=$("svc");p.className="pill "+cls;$("svcText").textContent=text}
function busy(btn,txt,on){var b=$(btn);b.disabled=on;if(on){b._old=b.innerHTML;b.innerHTML='<span class="spin"></span>'+txt}else if(b._old){b.innerHTML=b._old}}

function health(){
  api("/health",{token:false}).then(function(d){
    setSvc(d.offline_ready?"ok":"warn",d.offline_ready?"服务正常 · 私钥已就位":"服务正常 · 未配置 KEY_BLOB");
    if(!d.offline_ready){var n=$("keyHint");n.hidden=false;n.className="note bad";
      n.textContent="服务端还没有 KEY_BLOB。先在本地执行 node tools/keygen.mjs 生成私钥密文，再 wrangler secret put KEY_BLOB 上传，然后 wrangler secret put ISSUE_TOKEN。"}
  }).catch(function(e){setSvc("bad","连不上服务："+e.message)})
}

function remember(){
  try{var t=sessionStorage.getItem("kay_issue_token");if(t){token=t;$("token").value=t;$("remember").checked=true}}catch(e){}
}
function storeToken(){
  try{if($("remember").checked)sessionStorage.setItem("kay_issue_token",token);else sessionStorage.removeItem("kay_issue_token")}catch(e){}
}
$("token").addEventListener("input",function(){token=this.value.trim();storeToken()});
$("remember").addEventListener("change",storeToken);

$("unlockBtn").onclick=async function(){
  token=$("token").value.trim();derivedKey="";
  if(!token)return toast("先在顶栏填发卡令牌");
  var pass=$("pass").value;
  if(!pass)return toast("先填私钥口令");
  storeToken();busy("unlockBtn","派生密钥中…",true);
  var n=$("keyHint");n.hidden=true;
  try{
    var p=await api("/offline/params");
    var base=await crypto.subtle.importKey("raw",new TextEncoder().encode(pass),"PBKDF2",false,["deriveKey"]);
    var key=await crypto.subtle.deriveKey({name:"PBKDF2",salt:b64(p.salt),iterations:p.iterations,hash:"SHA-256"},
      base,{name:"AES-GCM",length:256},true,["encrypt","decrypt"]);
    derivedKey=toB64(new Uint8Array(await crypto.subtle.exportKey("raw",key)));
    pass="";$("pass").value="";
    var d=await api("/offline/issue",{method:"POST",body:{dry_run:true,derived_key:derivedKey}});
    pubKey=d.public_key;
    $("unlockState").className="pill ok";$("unlockState").innerHTML='<span class="dot"></span>已解锁';
    refreshCount();
    n.hidden=false;n.className="note ok";
    n.innerHTML='私钥已解锁，对应公钥：<code>'+esc(pubKey.slice(0,16))+'…</code> '+
      '<button class="sm" id="pkBtn" type="button">复制面板配置</button>'+
      '<div class="hint" style="margin:8px 0 0">这串公钥要写进面板 license.py 的 OFFLINE_PUBLIC_KEY，买家面板才认离线授权码；已写好就忽略。</div>';
    $("pkBtn").onclick=function(){copy('OFFLINE_PUBLIC_KEY = "'+pubKey+'"')};
    if(!ledgerLoaded)loadLedger();
  }catch(e){
    $("unlockState").className="pill bad";$("unlockState").innerHTML='<span class="dot"></span>解锁失败';
    n.hidden=false;n.className="note bad";
    n.textContent=e.reason==="key_unwrap_failed"?"口令不对，解不开私钥。":("解锁失败："+e.message);
  }finally{busy("unlockBtn","解锁私钥",false)}
};

function parsedMachines(){
  if($("anyMachine").checked)return[];
  var seen={},out=[];
  $("machines").value.split(/[\\n,;]+/).forEach(function(line){
    var v=line.trim().toUpperCase().replace(/[^A-Z0-9-]/g,"");
    if(!v||seen[v])return;seen[v]=1;out.push(v)});
  return out
}
function batchMode(){return $("anyMachine").checked}
function refreshCount(){
  var n=batchMode()?Math.max(parseInt($("count").value,10)||0,0):parsedMachines().length;
  $("countText").textContent=n+" 张";
  $("issueBtn").disabled=!(pubKey&&n>0&&n<=100)
}
$("machines").addEventListener("input",refreshCount);
$("count").addEventListener("input",refreshCount);
$("anyMachine").addEventListener("change",function(){
  $("machines").disabled=this.checked;$("countField").hidden=!this.checked;refreshCount()});
$("permanent").addEventListener("change",function(){$("days").disabled=this.checked});

$("issueBtn").onclick=async function(){
  busy("issueBtn","正在签发…",true);
  try{
    var d=await api("/offline/issue",{method:"POST",body:{
      derived_key:derivedKey,machines:parsedMachines(),any_machine:batchMode(),
      count:parseInt($("count").value,10)||1,
      days:parseInt($("days").value,10)||365,permanent:$("permanent").checked,note:$("note").value.trim()}});
    batch=d.issued||[];renderBatch();toast("已签发 "+batch.length+" 张");
    loadLedger()
  }catch(e){toast("签发失败："+e.message)}
  finally{busy("issueBtn","生成授权码",false);refreshCount()}
};

function renderBatch(){
  $("resultCard").hidden=batch.length===0;
  if(!batch.length)return;
  var rows=batch.map(function(r){
    return '<tr><td data-l="编号" class="mono">#'+esc(r.serial)+'</td><td data-l="买家设备" class="mono">'+esc(r.machine||"激活后自动绑定")+'</td>'+
    '<td data-l="到期"><span class="mono">'+dayText(r.expires_at)+'</span> '+(left(r.expires_at)?'<span class="tag warn">'+left(r.expires_at)+'</span>':"")+'</td>'+
    '<td data-l="备注">'+esc(r.note||"—")+'</td><td data-l="授权码"><div class="code">'+esc(r.code)+'</div></td>'+
    '<td data-l="操作"><div class="split"><button class="sm" data-copy="'+esc(r.code)+'">复制</button></div></td></tr>'}).join("");
  $("resultBody").innerHTML='<div style="overflow-x:auto"><table><thead><tr><th>编号</th><th>买家设备</th><th>到期</th><th>备注</th><th>授权码</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>'
}
function copy(text,label){
  var done=function(){toast((label||"内容")+"已复制")};
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(done,function(){fallback(text,done)})}
  else fallback(text,done);
}
function fallback(text,done){
  var t=document.createElement("textarea");t.value=text;t.style.position="fixed";t.style.opacity="0";
  document.body.appendChild(t);t.select();try{document.execCommand("copy");done()}catch(e){toast("复制失败，请手动选取")}document.body.removeChild(t)
}
$("resultBody").addEventListener("click",function(e){
  var b=e.target.closest("[data-copy]");if(b)copy(b.getAttribute("data-copy"),"授权码")});
$("copyAllBtn").onclick=function(){copy(batch.map(function(r){return(r.machine||"ANY")+"\\t"+r.code}).join("\\n"),"全部授权码")};
$("csvBtn").onclick=function(){
  var body="\\uFEFFserial,machine,expires_at,expires_day,note,code\\n"+batch.map(function(r){
    return[r.serial,r.machine||"",r.expires_at||"",dayText(r.expires_at),String(r.note||"").replace(/"/g,'""'),r.code]
      .map(function(v){return'"'+v+'"'}).join(",")}).join("\\n");
  try{
    var url=URL.createObjectURL(new Blob([body],{type:"text/csv;charset=utf-8"}));
    var a=document.createElement("a");a.href=url;a.download="kay-offline-"+Date.now()+".csv";a.click();
    setTimeout(function(){URL.revokeObjectURL(url)},1500);toast("CSV 已下载")
  }catch(e){copy(body,"CSV")}
};

$("refreshBtn").onclick=loadLedger;
$("search").addEventListener("keydown",function(e){if(e.key==="Enter")loadLedger()});
async function loadLedger(){
  if(!token){toast("先在顶栏填发卡令牌");return}
  busy("refreshBtn","读取中…",true);
  try{
    var q=$("search").value.trim();
    var d=await api("/admin/offline?limit=200"+(q?"&q="+encodeURIComponent(q):""));
    ledgerLoaded=true;renderLedger(d);
  }catch(e){$("ledgerBody").innerHTML='<div class="empty">读台账失败：'+esc(e.message)+'</div>'}
  finally{busy("refreshBtn","刷新",false)}
}
function renderLedger(d){
  var s=d.summary||{};
  $("summary").innerHTML=[["共签发",s.total],["已报到",s.reported],["已吊销",s.revoked],["30 天内到期",s.expiring]]
    .map(function(x){return'<div><b>'+esc(x[1]||0)+'</b><i>'+x[0]+'</i></div>'}).join("");
  var rows=(d.licenses||[]).map(function(r){
    var dead=Date.now()/1000>r.expires_at&&r.expires_at;
    var bound=r.bound_machine||r.machine||"";
    var tag=r.revoked?'<span class="tag off">已吊销</span>':dead?'<span class="tag off">已到期</span>':
      !bound?'<span class="tag gray">待激活</span>':(r.last_report_at?'<span class="tag">在用</span>':'<span class="tag gray">未报到</span>');
    return '<tr><td data-l="编号" class="mono">#'+esc(r.serial)+'</td><td data-l="买家设备" class="mono">'+
      (bound?esc(bound):'<span class="tag gray">未激活</span>')+
      (!r.machine&&bound&&r.unbind_count?' <span class="tag warn">解绑过 '+esc(r.unbind_count)+'</span>':"")+'</td>'+
    '<td data-l="到期"><span class="mono">'+dayText(r.expires_at)+'</span> '+(left(r.expires_at)?'<span class="tag warn">'+left(r.expires_at)+'</span>':"")+'</td>'+
    '<td data-l="报到"><span class="mono">'+(r.last_report_at?dayText(r.last_report_at):"—")+'</span>'+
      (r.machine_changed_at?' <span class="tag warn">换过机</span>':"")+(r.last_ip?' <span class="mono" style="font-size:11px;color:var(--subtle)">'+esc(r.last_ip)+'</span>':"")+'</td>'+
    '<td data-l="状态">'+tag+'</td><td data-l="备注">'+esc(r.note||"—")+'</td>'+
    '<td data-l="操作"><div class="split"><button class="sm mono" data-copy="'+esc(r.code)+'">复制码</button>'+
    (!r.machine&&bound?'<button class="sm" data-unbind="'+esc(r.serial)+'">解绑</button>':"")+
    '<button class="sm '+(r.revoked?"":"danger")+'" data-rev="'+esc(r.serial)+'" data-to="'+(r.revoked?0:1)+'">'+(r.revoked?"恢复":"吊销")+'</button></div></td></tr>'}).join("");
  $("ledgerBody").innerHTML=rows?'<div style="overflow-x:auto"><table><thead><tr><th>编号</th><th>买家设备</th><th>到期</th><th>最近报到</th><th>状态</th><th>备注</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>'
    :'<div class="empty">还没有签发记录</div>'
}
$("ledgerBody").addEventListener("click",async function(e){
  var c=e.target.closest("[data-copy]");if(c){copy(c.getAttribute("data-copy"),"授权码");return}
  var u=e.target.closest("[data-unbind]");
  if(u){
    var us=u.getAttribute("data-unbind");
    if(!confirm("解绑 #"+us+"：请让买家先停掉旧设备上的面板，否则旧设备下次报到会把绑定抢回去。\\n新设备下次报到时会自动绑上，确定解绑？"))return;
    u.disabled=true;
    try{await api("/admin/offline/"+us+"/unbind",{method:"POST",body:{}});
      toast("已解绑 #"+us);loadLedger()}
    catch(err){u.disabled=false;toast("解绑失败："+err.message)}
    return
  }
  var b=e.target.closest("[data-rev]");if(!b)return;
  var serial=b.getAttribute("data-rev"),to=b.getAttribute("data-to")==="1";
  if(to&&!confirm("吊销后买家面板下次报到就会锁定，确定？"))return;
  b.disabled=true;
  try{await api("/admin/offline/"+serial+"/revoke",{method:"POST",body:{revoked:to}});
    toast(to?"已吊销 #"+serial:"已恢复 #"+serial);loadLedger()}
  catch(err){b.disabled=false;toast("操作失败："+err.message)}
});

function switchTab(next){
  tab=next;
  var off=next==="offline";
  $("tabOffline").className="tab"+(off?" on":"");
  $("tabOnline").className="tab"+(off?"":" on");
  $("paneOffline").hidden=!off;
  $("paneOnline").hidden=off;
  if(!off&&!cardLoaded)loadCards()
}
$("tabOffline").onclick=function(){switchTab("offline")};
$("tabOnline").onclick=function(){switchTab("online")};

function refreshCardCount(){
  var n=Math.max(parseInt($("cardCount").value,10)||0,0);
  $("cardCountText").textContent=n+" 张";
  $("cardBtn").disabled=!(n>0&&n<=100)
}
$("cardCount").addEventListener("input",refreshCardCount);

$("cardBtn").onclick=async function(){
  if(!token){toast("先在顶栏填发卡令牌");return}
  busy("cardBtn","正在生成…",true);
  try{
    var d=await api("/admin/licenses",{method:"POST",body:{
      count:parseInt($("cardCount").value,10)||1,note:$("cardNote").value.trim()}});
    cardBatch=d.licenses||[];renderCardBatch();toast("已生成 "+cardBatch.length+" 张");
    loadCards()
  }catch(e){toast("生成失败："+e.message)}
  finally{busy("cardBtn","生成卡密",false)}
};

function renderCardBatch(){
  $("cardResultCard").hidden=cardBatch.length===0;
  if(!cardBatch.length)return;
  var rows=cardBatch.map(function(r,i){
    return '<tr><td data-l="#" class="mono">'+(i+1)+'</td>'+
    '<td data-l="卡密"><div class="mono" style="font-size:13px;color:var(--accent-text)">'+esc(r.code)+'</div></td>'+
    '<td data-l="备注">'+esc(r.note||"—")+'</td>'+
    '<td data-l="操作"><div class="split"><button class="sm" data-ccopy="'+esc(r.code)+'">复制</button></div></td></tr>'}).join("");
  $("cardResultBody").innerHTML='<div style="overflow-x:auto"><table><thead><tr><th>#</th><th>卡密（20 位）</th><th>备注</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>'
}
$("cardResultBody").addEventListener("click",function(e){
  var b=e.target.closest("[data-ccopy]");if(b)copy(b.getAttribute("data-ccopy"),"卡密")});
$("copyCardsBtn").onclick=function(){copy(cardBatch.map(function(r){return r.code}).join("\\n"),"全部卡密")};
$("cardCsvBtn").onclick=function(){
  var body="\\uFEFFcode,note,created_day\\n"+cardBatch.map(function(r){
    return['"'+r.code+'"','"'+String(r.note||"").replace(/"/g,'""')+'"','"'+dayText(r.created_at)+'"'].join(",")}).join("\\n");
  try{
    var url=URL.createObjectURL(new Blob([body],{type:"text/csv;charset=utf-8"}));
    var a=document.createElement("a");a.href=url;a.download="kay-cards-"+Date.now()+".csv";a.click();
    setTimeout(function(){URL.revokeObjectURL(url)},1500);toast("CSV 已下载")
  }catch(e){copy(body,"CSV")}
};

$("cardRefreshBtn").onclick=loadCards;
$("cardSearch").addEventListener("keydown",function(e){if(e.key==="Enter")loadCards()});
async function loadCards(){
  if(!token){toast("先在顶栏填发卡令牌");return}
  busy("cardRefreshBtn","读取中…",true);
  try{
    var q=$("cardSearch").value.trim();
    var d=await api("/admin/licenses?limit=200"+(q?"&q="+encodeURIComponent(q):""));
    cardLoaded=true;renderCards(d);
  }catch(e){$("cardLedger").innerHTML='<div class="empty">读卡密失败：'+esc(e.message)+'</div>'}
  finally{busy("cardRefreshBtn","刷新",false)}
}
function renderCards(d){
  var s=d.summary||{};
  $("cardSummary").innerHTML=[["共发卡",s.total],["已绑定设备",s.bound],["已吊销",s.revoked]]
    .map(function(x){return'<div><b>'+esc(x[1]||0)+'</b><i>'+x[0]+'</i></div>'}).join("");
  var rows=(d.licenses||[]).map(function(r){
    var bound=r.bound_machine||"";
    var tag=r.revoked?'<span class="tag off">已吊销</span>':bound?'<span class="tag">在用</span>':'<span class="tag gray">未激活</span>';
    return '<tr><td data-l="卡密"><div class="mono" style="font-size:12.5px;color:var(--accent-text)">'+esc(r.code)+'</div></td>'+
    '<td data-l="买家设备" class="mono">'+(bound?esc(bound):'<span class="tag gray">未激活</span>')+
      (r.unbind_count?' <span class="tag warn">解绑过 '+esc(r.unbind_count)+'</span>':"")+'</td>'+
    '<td data-l="最近校验"><span class="mono">'+(r.last_verify_at?dayText(r.last_verify_at):"—")+'</span>'+
      (r.last_ip?' <span class="mono" style="font-size:11px;color:var(--subtle)">'+esc(r.last_ip)+'</span>':"")+'</td>'+
    '<td data-l="状态">'+tag+'</td><td data-l="备注">'+esc(r.note||"—")+'</td>'+
    '<td data-l="操作"><div class="split"><button class="sm mono" data-ccopy="'+esc(r.code)+'">复制</button>'+
    (bound?'<button class="sm" data-cunbind="'+esc(r.code)+'">解绑</button>':"")+
    '<button class="sm '+(r.revoked?"":"danger")+'" data-crev="'+esc(r.code)+'" data-to="'+(r.revoked?0:1)+'">'+(r.revoked?"恢复":"吊销")+'</button></div></td></tr>'}).join("");
  $("cardLedger").innerHTML=rows?'<div style="overflow-x:auto"><table><thead><tr><th>卡密</th><th>买家设备</th><th>最近校验</th><th>状态</th><th>备注</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>'
    :'<div class="empty">还没有卡密</div>'
}
$("cardLedger").addEventListener("click",async function(e){
  var c=e.target.closest("[data-ccopy]");if(c){copy(c.getAttribute("data-ccopy"),"卡密");return}
  var u=e.target.closest("[data-cunbind]");
  if(u){
    var uc=u.getAttribute("data-cunbind");
    if(!confirm("解绑 "+uc+"：请让买家先停掉旧设备上的面板，否则旧设备下次校验会把绑定抢回去。\\n新设备下次校验时会自动绑上，确定解绑？"))return;
    u.disabled=true;
    try{await api("/admin/licenses/"+encodeURIComponent(uc)+"/unbind",{method:"POST",body:{}});
      toast("已解绑");loadCards()}
    catch(err){u.disabled=false;toast("解绑失败："+err.message)}
    return
  }
  var b=e.target.closest("[data-crev]");if(!b)return;
  var code=b.getAttribute("data-crev"),to=b.getAttribute("data-to")==="1";
  if(to&&!confirm("吊销后买家面板下次校验就会锁定，确定？"))return;
  b.disabled=true;
  try{await api("/admin/licenses/"+encodeURIComponent(code)+"/revoke",{method:"POST",body:{revoked:to}});
    toast(to?"已吊销":"已恢复");loadCards()}
  catch(err){b.disabled=false;toast("操作失败："+err.message)}
});

(function theme(){
  var saved=null;try{saved=localStorage.getItem("kay_issue_theme")}catch(e){}
  var want=saved|| (matchMedia("(prefers-color-scheme: light)").matches?"light":"dark");
  apply(want);
  $("themeBtn").onclick=function(){apply(document.documentElement.dataset.theme==="dark"?"light":"dark")}
  function apply(t){document.documentElement.dataset.theme=t;try{localStorage.setItem("kay_issue_theme",t)}catch(e){}
    $("themeBtn").textContent=t==="dark"?"浅色":"深色"}
})();
remember();health();refreshCardCount();
$("token").addEventListener("keydown",function(e){if(e.key==="Enter"){tab==="offline"?$("unlockBtn").click():loadCards()}});
$("pass").addEventListener("keydown",function(e){if(e.key==="Enter")$("unlockBtn").click()});
</script>
</body>
</html>`;
