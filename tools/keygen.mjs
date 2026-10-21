#!/usr/bin/env node
// 生成离线授权用的 Ed25519 密钥对：
//   · 公钥（十六进制）填进面板 license.py 的 OFFLINE_PUBLIC_KEY；
//   · 私钥种子只以口令加密后的密文形式落盘/上传为 Worker secret，明文私钥永不落盘。
//
// 用法：node tools/keygen.mjs [--out tools/offline-key.json] [--passphrase-env NAME] [--force]

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { publicKeyFromSeed } from "../license-worker/src/ed25519.mjs";
import { decryptSeed, encryptSeed } from "../license-worker/src/keywrap.mjs";
import { readPassphrase } from "./prompt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const opts = { out: path.join(ROOT, "tools", "offline-key.json"), force: false, passphraseEnv: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out") opts.out = path.resolve(argv[++i] || "");
    else if (arg === "--passphrase-env") opts.passphraseEnv = argv[++i] || null;
    else if (arg === "--force") opts.force = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error("未知参数：" + arg);
  }
  return opts;
}

async function getPassphrase(opts) {
  if (opts.passphraseEnv) {
    const value = process.env[opts.passphraseEnv] || "";
    if (value.length < 8) throw new Error("环境变量 " + opts.passphraseEnv + " 里的口令太短（至少 8 位）");
    return value;
  }
  for (;;) {
    const first = await readPassphrase("设置私钥口令（至少 8 位，不可找回）：");
    if (first.length < 8) {
      console.log("口令太短，请重来。");
      continue;
    }
    const second = await readPassphrase("再输入一次确认：");
    if (first !== second) {
      console.log("两次输入不一致，请重来。");
      continue;
    }
    return first;
  }
}

function toHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("用法：node tools/keygen.mjs [--out tools/offline-key.json] [--passphrase-env NAME] [--force]");
    return;
  }
  if (!opts.force) {
    try {
      await fs.access(opts.out);
      throw new Error(opts.out + " 已存在。覆盖会让已签发的授权码全部失效，确认后用 --force");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const seed = new Uint8Array(randomBytes(32));
  const publicKey = toHex(await publicKeyFromSeed(seed));
  const passphrase = await getPassphrase(opts);
  const blob = await encryptSeed(seed, passphrase);
  const restored = toHex(await publicKeyFromSeed(await decryptSeed(blob, passphrase)));
  seed.fill(0);
  if (restored !== publicKey) throw new Error("密文自检失败：解出的私钥与公钥不匹配");

  await fs.mkdir(path.dirname(opts.out), { recursive: true });
  await fs.writeFile(opts.out, JSON.stringify(blob, null, 2) + "\n", { mode: 0o600 });

  console.log("");
  console.log("公钥（填进 license.py）：");
  console.log('OFFLINE_PUBLIC_KEY = "' + publicKey + '"');
  console.log("");
  console.log("私钥密文已写入：" + path.relative(ROOT, opts.out));
  console.log("上传为 Worker secret：");
  console.log("  npx wrangler secret put KEY_BLOB < " + path.relative(ROOT, opts.out));
  console.log("");
  console.log("口令：" + (opts.passphraseEnv ? "来自环境变量 " + opts.passphraseEnv : "只存在你刚才的输入里，未写入任何文件"));
  console.log("注意：口令遗失 = 私钥作废，需要重新 keygen 并给所有买家换发授权码。");
}

main().catch((error) => {
  console.error("[!] " + (error && error.message ? error.message : error));
  process.exitCode = 1;
});
