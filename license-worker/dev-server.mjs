#!/usr/bin/env node
// 本地预览发卡台：内存 KV + 临时私钥，只用于在浏览器里看效果，不是部署方式。
// 每次启动生成一把新私钥并打印对应公钥，进程退出即消失；KV 数据不落地。
//
//   node license-worker/dev-server.mjs [端口]
//   打开 http://127.0.0.1:8788/issue
import http from "node:http";

import worker from "./src/worker.js";
import { MemoryKV } from "./test-support/memory-kv.mjs";
import { encryptSeed } from "./src/keywrap.mjs";
import { publicKeyFromSeed } from "./src/ed25519.mjs";

const passphrase = process.env.KAY_DEMO_PASSPHRASE || "demo passphrase 12345";
const issueToken = process.env.KAY_DEMO_ISSUE_TOKEN || "demo-issue-token";
const adminToken = process.env.KAY_DEMO_ADMIN_TOKEN || "demo-admin-token";
const port = Number(process.argv[2] || 8788);

const seed = crypto.getRandomValues(new Uint8Array(32));
const blob = await encryptSeed(seed, passphrase);
const publicKeyHex = Array.from(await publicKeyFromSeed(seed), (b) => b.toString(16).padStart(2, "0")).join("");
seed.fill(0);

const env = {
  LICENSES: new MemoryKV(),
  ADMIN_TOKEN: adminToken,
  ISSUE_TOKEN: issueToken,
  KEY_BLOB: JSON.stringify(blob),
};

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    try {
      const url = new URL(req.url, "http://" + (req.headers.host || "127.0.0.1:" + port));
      const method = req.method || "GET";
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined && name !== "host") headers.set(name, Array.isArray(value) ? value[0] : value);
      }
      headers.set("CF-Connecting-IP", req.socket.remoteAddress || "127.0.0.1");
      const body = chunks.length && method !== "GET" && method !== "HEAD" ? Buffer.concat(chunks) : undefined;
      const response = await worker.fetch(new Request(url, { method, headers, body }), env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(String(error && error.message ? error.message : error));
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log("发卡台预览：http://127.0.0.1:" + port + "/issue");
  console.log("  发卡令牌 ISSUE_TOKEN：" + issueToken);
  console.log("  私钥口令：" + passphrase);
  console.log("  对应公钥 OFFLINE_PUBLIC_KEY = \"" + publicKeyHex + "\"");
  console.log("  管理员令牌 ADMIN_TOKEN：" + adminToken + "（在线卡密接口用）");
});
