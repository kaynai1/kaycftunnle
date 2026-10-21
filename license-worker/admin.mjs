#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// 卡密管理 CLI：默认只依赖 Node 18+ 自带的 fetch（走代理时才需要 undici）
//
//   set KAY_LICENSE_URL=https://kay-license.<account>.workers.dev
//   set KAY_LICENSE_ADMIN_TOKEN=<ADMIN_TOKEN>
//   set KAY_LICENSE_PROXY=http://127.0.0.1:7897   （可选，本机直连不通 workers.dev 时走代理）
//   node admin.mjs new --count 5 --note "闲鱼订单 20261021"
//   node admin.mjs list
//   node admin.mjs show KAY-XXXX-XXXX-XXXX
//   node admin.mjs revoke KAY-XXXX-XXXX-XXXX
//   node admin.mjs restore KAY-XXXX-XXXX-XXXX
//   node admin.mjs unbind KAY-XXXX-XXXX-XXXX

const BASE = (process.env.KAY_LICENSE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.KAY_LICENSE_ADMIN_TOKEN || "";
const PROXY = process.env.KAY_LICENSE_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || "";

function die(message) {
  console.error("✗ " + message);
  process.exit(1);
}

if (!BASE) die("请先设置 KAY_LICENSE_URL，例如 https://kay-license.xxx.workers.dev");
if (!TOKEN) die("请先设置 KAY_LICENSE_ADMIN_TOKEN");

let dispatcherTask = null;
function getDispatcher() {
  if (!PROXY) return Promise.resolve(undefined);
  if (!dispatcherTask) {
    dispatcherTask = import("undici")
      .then(({ ProxyAgent }) => new ProxyAgent(PROXY))
      .catch(() => die("要走代理却缺少 undici，请在 license-worker 目录执行 npm install"));
  }
  return dispatcherTask;
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function api(method, path, body) {
  const dispatcher = await getDispatcher();
  let response;
  try {
    response = await fetch(BASE + path, {
      method,
      headers: {
        Authorization: "Bearer " + TOKEN,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      ...(dispatcher ? { dispatcher } : {}),
    });
  } catch (error) {
    const hint = PROXY ? "（代理 " + PROXY + " 不通？）" : "（本机直连不通时可设 KAY_LICENSE_PROXY=http://127.0.0.1:7897）";
    die("无法连接授权服务：" + error.message + hint);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    die("授权服务返回了非 JSON 内容（HTTP " + response.status + "）");
  }
  if (!response.ok || data.ok === false) {
    die((data.error || "请求失败") + "（HTTP " + response.status + "）");
  }
  return data;
}

function fmtTime(sec) {
  if (!sec) return "-";
  return new Date(sec * 1000).toLocaleString("zh-CN", { hour12: false });
}

function printRecord(record) {
  console.log("卡密      " + record.code);
  if (record.note) console.log("备注      " + record.note);
  console.log("状态      " + (record.revoked ? "已吊销" : record.bound_machine ? "已激活" : "未激活"));
  console.log("绑定设备  " + (record.bound_machine || "-"));
  console.log("激活时间  " + fmtTime(record.activated_at));
  console.log("最近校验  " + fmtTime(record.last_verify_at));
  console.log("校验次数  " + (record.verify_count || 0));
  console.log("最近 IP   " + (record.last_ip || "-"));
}

const [command, ...rest] = process.argv.slice(2);
const { positional, flags } = parseArgs(rest);

try {
  if (command === "new") {
    const count = parseInt(flags.count || "1", 10);
    if (!Number.isFinite(count) || count < 1 || count > 100) die("--count 需在 1-100 之间");
    const data = await api("POST", "/admin/licenses", {
      count,
      note: flags.note || "",
    });
    console.log("已生成 " + data.count + " 条卡密：\n");
    for (const record of data.licenses) console.log(record.code);
    console.log("\n备注：" + (data.licenses[0]?.note || "-"));
  } else if (command === "list") {
    const query = flags.q ? "?q=" + encodeURIComponent(String(flags.q)) : "";
    const data = await api("GET", "/admin/licenses" + query);
    console.log(
      "共 " + data.summary.total + " 条 · 已绑定 " + data.summary.bound + " · 已吊销 " + data.summary.revoked
    );
    console.log("");
    console.log("卡密".padEnd(20) + "状态".padEnd(8) + "绑定设备".padEnd(24) + "备注");
    console.log("-".repeat(84));
    for (const r of data.licenses) {
      const status = r.revoked ? "已吊销" : r.bound_machine ? "已激活" : "未激活";
      const machine = r.bound_machine || "-";
      console.log(
        (r.code || "").padEnd(20) + status.padEnd(8) + machine.padEnd(24) + (r.note || "")
      );
    }
  } else if (command === "show") {
    const code = positional[0];
    if (!code) die("用法：node admin.mjs show KAY-XXXX-XXXX-XXXX");
    const data = await api("GET", "/admin/licenses/" + encodeURIComponent(code));
    printRecord(data.license);
  } else if (command === "revoke" || command === "restore") {
    const code = positional[0];
    if (!code) die("用法：node admin.mjs " + command + " KAY-XXXX-XXXX-XXXX");
    const data = await api("POST", "/admin/licenses/" + encodeURIComponent(code) + "/revoke", {
      revoked: command === "revoke",
    });
    console.log("✓ " + data.message);
    printRecord(data.license);
  } else if (command === "unbind") {
    const code = positional[0];
    if (!code) die("用法：node admin.mjs unbind KAY-XXXX-XXXX-XXXX");
    const data = await api("POST", "/admin/licenses/" + encodeURIComponent(code) + "/unbind", {});
    console.log("✓ " + data.message);
    printRecord(data.license);
  } else {
    console.log(`用法：
  node admin.mjs new [--count N] [--note "备注"]
  node admin.mjs list [--q 关键词]
  node admin.mjs show   KAY-XXXX-XXXX-XXXX
  node admin.mjs revoke KAY-XXXX-XXXX-XXXX
  node admin.mjs restore KAY-XXXX-XXXX-XXXX
  node admin.mjs unbind KAY-XXXX-XXXX-XXXX`);
  }
} catch (error) {
  die(error.message);
}
