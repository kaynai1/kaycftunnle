#!/usr/bin/env node
// 本地批量签发离线授权码：读口令解开的私钥密文，按机器码签发，并把签发记录写进台账。
//
// 用法示例：
//   node tools/issue.mjs --machine NAS-AAAA-BBBB-CCCC --note "闲鱼订单123"
//   node tools/issue.mjs --file machines.txt --days 365 --out codes.txt
//   node tools/issue.mjs --machine NAS-AAAA-BBBB-CCCC --permanent
//   node tools/issue.mjs --list

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FLAG_ANY_MACHINE, FLAG_PERMANENT, issueOfflineLicense, packMachine } from "../license-worker/src/offline.mjs";
import { decryptSeed } from "../license-worker/src/keywrap.mjs";
import { readPassphrase } from "./prompt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAY = 86400;

const USAGE = `用法：node tools/issue.mjs [选项]

  --machine <机器码>   可重复；为某个 NAS 签发
  --file <路径>        每行一个机器码，# 开头为注释
  --any-machine        不绑定机器码（测试用，别发给买家）
  --days <N>           有效期天数，默认 365
  --permanent          永久有效（覆盖 --days）
  --note <文本>        备注（买家昵称/订单号），写进台账
  --serial <N>         指定起始编号，默认取台账最大值 +1
  --blob <路径>        私钥密文，默认 tools/offline-key.json
  --passphrase-env <环境变量名>  从环境变量读口令
  --out <路径>         另外把「机器码 + 授权码」写成一行一条的文件
  --ledger <路径>      台账，默认 tools/issued.json
  --list [N]           只列出台账里最近 N 条（默认 20）
`;

function parseArgs(argv) {
  const opts = {
    machines: [],
    days: 365,
    permanent: false,
    anyMachine: false,
    note: "",
    serial: 0,
    blob: path.join(ROOT, "tools", "offline-key.json"),
    ledger: path.join(ROOT, "tools", "issued.json"),
    passphraseEnv: null,
    out: "",
    list: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--machine") opts.machines.push(String(next() || ""));
    else if (arg === "--file") opts.file = path.resolve(next() || "");
    else if (arg === "--note") opts.note = String(next() || "");
    else if (arg === "--days") opts.days = parseInt(next(), 10);
    else if (arg === "--blob") opts.blob = path.resolve(next() || "");
    else if (arg === "--ledger") opts.ledger = path.resolve(next() || "");
    else if (arg === "--out") opts.out = path.resolve(next() || "");
    else if (arg === "--passphrase-env") opts.passphraseEnv = next() || null;
    else if (arg === "--serial") opts.serial = parseInt(next(), 10);
    else if (arg === "--permanent") opts.permanent = true;
    else if (arg === "--any-machine") opts.anyMachine = true;
    else if (arg === "--list") opts.list = Number(argv[i + 1] || 20) || 20;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error("未知参数：" + arg + "\n\n" + USAGE);
  }
  if (!Number.isInteger(opts.days) || opts.days < 1) throw new Error("--days 需要是正整数");
  if (!Number.isInteger(opts.serial) || opts.serial < 0) throw new Error("--serial 需要是正整数");
  return opts;
}

async function readMachines(opts) {
  const list = opts.machines.slice();
  if (opts.file) {
    const raw = await fs.readFile(opts.file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      for (const part of trimmed.split(/[,\s]+/)) if (part) list.push(part);
    }
  }
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const code = item.trim().toUpperCase();
    if (!code) continue;
    packMachine(code);
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

async function loadLedger(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, "utf8"));
    if (Array.isArray(data.entries)) return data;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  return { entries: [] };
}

function dayText(ts) {
  if (!ts) return "永久";
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const ledger = await loadLedger(opts.ledger);

  if (opts.list) {
    for (const entry of ledger.entries.slice(-opts.list)) {
      console.log(
        "#" + entry.serial + "\t" + (entry.machine || "不绑定") + "\t" + dayText(entry.expires_at) +
        "\t" + (entry.note || "") + "\t" + entry.code.slice(0, 20) + "…"
      );
    }
    console.log("共 " + ledger.entries.length + " 条，台账：" + path.relative(ROOT, opts.ledger));
    return;
  }

  const machines = await readMachines(opts);
  if (!machines.length && !opts.anyMachine) throw new Error("没有要签发的机器码（--machine 或 --file）");
  if (machines.length && opts.anyMachine) throw new Error("--any-machine 与 --machine 不能同时使用");
  const targets = opts.anyMachine ? [""] : machines;

  let passphrase;
  if (opts.passphraseEnv) {
    passphrase = process.env[opts.passphraseEnv] || "";
    if (!passphrase) throw new Error("环境变量 " + opts.passphraseEnv + " 为空");
  } else {
    passphrase = await readPassphrase("私钥口令：");
  }

  const blob = JSON.parse(await fs.readFile(opts.blob, "utf8"));
  const seed = await decryptSeed(blob, passphrase);

  const now = Math.floor(Date.now() / 1000);
  const lastSerial = ledger.entries.reduce((max, e) => Math.max(max, Number(e.serial) || 0), 0);
  // 编号从当前秒时间戳起步，和 Worker 发卡后台同源，两边同时签发也不会撞号
  let serial = opts.serial || Math.max(now, lastSerial + 1);

  const flags = (opts.anyMachine ? FLAG_ANY_MACHINE : 0) | (opts.permanent ? FLAG_PERMANENT : 0);
  const expiresAt = opts.permanent ? 0 : now + opts.days * DAY;
  const rows = [];
  for (const machine of targets) {
    const code = await issueOfflineLicense(seed, {
      flags,
      machine,
      serial,
      issuedAt: now,
      expiresAt,
    });
    ledger.entries.push({
      serial,
      machine,
      expires_at: expiresAt,
      issued_at: now,
      note: opts.note,
      code,
    });
    rows.push({ serial, machine, expiresAt, code });
    serial += 1;
  }
  seed.fill(0);

  await fs.mkdir(path.dirname(opts.ledger), { recursive: true });
  await fs.writeFile(opts.ledger, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });

  if (opts.out) {
    const body = rows.map((r) => (r.machine || "ANY") + "\t" + r.code).join("\n") + "\n";
    await fs.writeFile(opts.out, body);
    console.log("授权码已写入 " + path.relative(ROOT, opts.out));
  }

  console.log("");
  for (const row of rows) {
    console.log("#" + row.serial + "\t" + (row.machine || "不绑定机器") + "\t到期 " + dayText(row.expiresAt));
    console.log(row.code);
    console.log("");
  }
  console.log("已签发 " + rows.length + " 张，编号 " + rows[0].serial + "–" + rows[rows.length - 1].serial +
    "，台账：" + path.relative(ROOT, opts.ledger));
}

main().catch((error) => {
  console.error("[!] " + (error && error.message ? error.message : error));
  process.exitCode = 1;
});
