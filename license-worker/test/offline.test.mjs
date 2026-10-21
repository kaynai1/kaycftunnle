// SPDX-License-Identifier: MIT
// 离线授权链路：浏览器派生密钥 → Worker 解开私钥 → 签发 → 面板报到 → 后台吊销
import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { MemoryKV } from "../test-support/memory-kv.mjs";
import { decodeOfflineLicense, FLAG_ANY_MACHINE, FLAG_PERMANENT, OFFLINE_PREFIX } from "../src/offline.mjs";
import { deriveAesKey, encryptSeed, fromB64, parseBlob, toB64 } from "../src/keywrap.mjs";
import { publicKeyFromSeed, verify } from "../src/ed25519.mjs";

const ADMIN_TOKEN = "test-admin-token";
const ISSUE_TOKEN = "test-issue-token";
const PASSPHRASE = "correct horse battery staple";
const SEED = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i + 1));
const MACHINE_A = "NAS-AAAA-BBBB-CCCC";
const MACHINE_B = "NAS-DDDD-EEEE-FFFF";

const kv = new MemoryKV();
const blob = await encryptSeed(SEED, PASSPHRASE);
const env = { LICENSES: kv, ADMIN_TOKEN, ISSUE_TOKEN, KEY_BLOB: JSON.stringify(blob) };

let ipSeq = 0;
function call(path, { method = "GET", body, token, ip } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  headers["CF-Connecting-IP"] = ip || "203.0.113." + (++ipSeq % 200);
  return worker.fetch(
    new Request("https://license.test" + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env
  );
}

async function read(response) {
  return { status: response.status, data: await response.json() };
}

function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// 发卡页做的事：口令 + salt 在浏览器里跑 PBKDF2，只把派生出来的 AES 密钥交给 Worker
async function derivedKeyB64(passphrase = PASSPHRASE, parsed = parseBlob(JSON.stringify(blob))) {
  const key = await deriveAesKey(passphrase, fromB64(parsed.salt), parsed.iterations, true);
  return toB64(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}

async function issue(fields) {
  return read(
    await call("/offline/issue", {
      method: "POST",
      token: ISSUE_TOKEN,
      body: { derived_key: await derivedKeyB64(fields.passphrase ?? undefined), ...fields.body },
    })
  );
}

test("签发需要 ISSUE_TOKEN，未配置时返回 503", async () => {
  assert.equal((await call("/offline/issue", { method: "POST", body: {} })).status, 401);
  assert.equal((await call("/offline/issue", { method: "POST", token: "wrong", body: {} })).status, 401);
  const bare = { LICENSES: kv, ADMIN_TOKEN };
  const response = await worker.fetch(
    new Request("https://license.test/offline/issue", { method: "POST", body: "{}" }),
    bare
  );
  assert.equal(response.status, 503);
  assert.equal((await response.json()).reason, "issue_not_configured");
});

test("口令不对时解不开私钥，拒绝签发", async () => {
  const parsed = parseBlob(JSON.stringify(blob));
  const wrong = await derivedKeyB64("wrong passphrase", parsed);
  const { status, data } = await read(
    await call("/offline/issue", { method: "POST", token: ISSUE_TOKEN, body: { derived_key: wrong, machines: [MACHINE_A] } })
  );
  assert.equal(status, 400);
  assert.equal(data.reason, "key_unwrap_failed");

  const missing = await read(
    await call("/offline/issue", { method: "POST", token: ISSUE_TOKEN, body: { machines: [MACHINE_A] } })
  );
  assert.equal(missing.status, 400);
  assert.equal(missing.data.reason, "key_unwrap_failed");
});

test("机器码校验与批量签发", async () => {
  const empty = await issue({ body: { machines: [] } });
  assert.equal(empty.status, 400);
  assert.equal(empty.data.reason, "invalid_machine");

  const bad = await issue({ body: { machines: [MACHINE_A, "hello-world"] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.reason, "invalid_machine");

  const tooMany = await issue({ body: { machines: Array.from({ length: 101 }, (_, i) => "NAS-AAAA-AAAA-" + String(i).padStart(4, "0")) } });
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.data.reason, "too_many");

  const { status, data } = await issue({
    body: { machines: [MACHINE_A.toLowerCase(), MACHINE_B, MACHINE_A], days: 30, note: "闲鱼批次 B" },
  });
  assert.equal(status, 200);
  assert.equal(data.count, 2, "小写与重复机器码应归一成两张");
  const first = decodeOfflineLicense(data.issued[0].code);
  assert.equal(first.machine, MACHINE_A);
  assert.equal(first.flags & FLAG_ANY_MACHINE, 0);
  assert.ok(first.expires_at > first.issued_at);
  assert.equal(data.issued[0].serial, first.serial);
  assert.ok(data.issued[1].serial > data.issued[0].serial);
});

test("永久与不绑定机器码的授权码", async () => {
  const permanent = await issue({ body: { machines: [MACHINE_A], permanent: true } });
  assert.equal(permanent.status, 200);
  assert.equal(permanent.data.expires_at, 0);
  const perm = decodeOfflineLicense(permanent.data.issued[0].code);
  assert.equal(perm.expires_at, 0);
  assert.notEqual(perm.flags & FLAG_PERMANENT, 0);

  const loose = await issue({ body: { any_machine: true, days: 7 } });
  assert.equal(loose.status, 200);
  assert.equal(loose.data.count, 1);
  const any = decodeOfflineLicense(loose.data.issued[0].code);
  assert.notEqual(any.flags & FLAG_ANY_MACHINE, 0);
  assert.equal(any.machine, "");
});

test("签发记录会写进 KV 台账", async () => {
  const { data } = await issue({ body: { machines: [MACHINE_A], note: "配对检查" } });
  const record = JSON.parse(await kv.get("offline:" + data.issued[0].serial));
  assert.equal(record.code, data.issued[0].code);
  assert.equal(record.machine, MACHINE_A);
  assert.equal(record.revoked, false);
  assert.equal(record.note, "配对检查");
  assert.ok(data.issued[0].code.startsWith(OFFLINE_PREFIX + "-"));
});

test("签发的码能被同一私钥的公钥验签", async () => {
  const publicKey = await publicKeyFromSeed(SEED);
  const { data } = await issue({ body: { machines: [MACHINE_A], days: 365, note: "验签检查" } });
  const parsed = decodeOfflineLicense(data.issued[0].code);
  assert.equal(await verify(publicKey, parsed.payload, parsed.signature), true);

  const tampered = Uint8Array.from(parsed.payload);
  tampered[10] ^= 0x01; // 改编号
  assert.equal(await verify(publicKey, tampered, parsed.signature), false);
  const otherKey = await publicKeyFromSeed(Uint8Array.from(SEED, (b) => b ^ 0xff));
  assert.equal(await verify(otherKey, parsed.payload, parsed.signature), false);
});

test("报到：未知编号不影响使用，已知编号记台账", async () => {
  const unknown = await read(await call("/offline/report", { method: "POST", body: { serial: 999999999, machine_code: MACHINE_A } }));
  assert.equal(unknown.status, 200);
  assert.equal(unknown.data.known, false);
  assert.equal(unknown.data.revoked, false);

  const issued = await issue({ body: { machines: [MACHINE_A], note: "报到流程" } });
  const serial = issued.data.issued[0].serial;
  const putsAfterIssue = kv.puts;
  const report = await read(await call("/offline/report", { method: "POST", body: { serial, machine_code: MACHINE_A } }));
  assert.equal(report.status, 200);
  assert.equal(report.data.known, true);
  assert.ok(report.data.reported_at > 0);
  assert.ok(kv.puts > putsAfterIssue, "首次报到应写台账");

  const putsAfterFirstReport = kv.puts;
  const repeat = await read(await call("/offline/report", { method: "POST", body: { serial, machine_code: MACHINE_A } }));
  assert.equal(repeat.data.revoked, false);
  assert.equal(kv.puts, putsAfterFirstReport, "同机重复报到不应再写 KV");
  const record = JSON.parse(await kv.get("offline:" + serial));
  assert.equal(record.report_count, 1);
  assert.equal(record.last_machine, MACHINE_A);
});

test("后台吊销后报到返回 revoked，恢复后重新可用", async () => {
  const issued = await issue({ body: { machines: [MACHINE_A], note: "吊销流程" } });
  const serial = issued.data.issued[0].serial;

  const noAuth = await read(await call("/admin/offline/" + serial + "/revoke", { method: "POST", body: {} }));
  assert.equal(noAuth.status, 401);

  const revoked = await read(
    await call("/admin/offline/" + serial + "/revoke", { method: "POST", token: ADMIN_TOKEN, body: {} })
  );
  assert.equal(revoked.status, 200);
  assert.equal(revoked.data.license.revoked, true);

  const report = await read(await call("/offline/report", { method: "POST", body: { serial, machine_code: MACHINE_A } }));
  assert.equal(report.data.ok, true, "报到本身成功，结论看 revoked");
  assert.equal(report.data.revoked, true);
  assert.match(report.data.error, /吊销/);

  const detail = await read(await call("/admin/offline/" + serial, { token: ADMIN_TOKEN }));
  assert.equal(detail.data.license.revoked_at > 0, true);

  await call("/admin/offline/" + serial + "/revoke", { method: "POST", token: ADMIN_TOKEN, body: { revoked: false } });
  const restored = await read(await call("/offline/report", { method: "POST", body: { serial, machine_code: MACHINE_A } }));
  assert.equal(restored.data.revoked, false);
});

test("写死机器码的授权码换机报到会被拒绝", async () => {
  const issued = await issue({ body: { machines: [MACHINE_A], note: "换机检查" } });
  const serial = issued.data.issued[0].serial;
  await call("/offline/report", { method: "POST", body: { serial, machine_code: MACHINE_A } });
  const moved = await read(await call("/offline/report", { method: "POST", body: { serial, machine_code: MACHINE_B } }));
  assert.equal(moved.data.ok, true, "报到成功，结论看 device_mismatch");
  assert.equal(moved.data.device_mismatch, true);
  assert.equal(moved.data.revoked, false);
  const record = JSON.parse(await kv.get("offline:" + serial));
  assert.equal(record.first_machine, MACHINE_A);
  assert.equal(record.last_machine, MACHINE_A, "别人的机器码不该覆盖台账里的绑定");
  assert.equal(record.mismatch_count, 1);
});

test("批量预生成：一次出多张不绑机器的码", async () => {
  const { data } = await issue({ body: { any_machine: true, count: 5, days: 30, note: "闲鱼批量" } });
  assert.equal(data.count, 5);
  assert.equal(new Set(data.issued.map((r) => r.serial)).size, 5, "编号不能重复");
  for (const one of data.issued) {
    assert.equal(one.machine, "");
    assert.equal(one.unbindable, false, "还没绑设备就不该有解绑按钮");
    const parsed = decodeOfflineLicense(one.code);
    assert.notEqual(parsed.flags & FLAG_ANY_MACHINE, 0);
    assert.equal(parsed.machine, "");
  }

  const capped = await issue({ body: { any_machine: true, count: 500 } });
  assert.equal(capped.status, 400);
  assert.equal(capped.data.reason, "too_many");
});

test("批量码首次报到自动绑定，别人再用会被锁，解绑后新设备可再绑", async () => {
  const { data } = await issue({ body: { any_machine: true, count: 2, note: "首绑流程" } });
  const serial = data.issued[0].serial;
  const fresh = data.issued[1].serial;

  const first = await read(await call("/offline/report", { method: "POST", body: { serial, machine_code: MACHINE_A } }));
  assert.equal(first.data.ok, true);
  assert.equal(first.data.bound, true);
  const bound = JSON.parse(await kv.get("offline:" + serial));
  assert.equal(bound.bound_machine, MACHINE_A);
  assert.ok(bound.bound_at > 0);

  const repeat = await read(await call("/offline/report", { method: "POST", body: { serial, machine_code: MACHINE_A } }));
  assert.equal(repeat.data.ok, true);
  assert.equal(repeat.data.bound, undefined, "已绑定后的重复报到不再算首绑");

  const stolen = await read(await call("/offline/report", { method: "POST", body: { serial, machine_code: MACHINE_B } }));
  assert.equal(stolen.data.device_mismatch, true);
  assert.match(stolen.data.error, /解绑/);

  const notYet = await read(
    await call("/admin/offline/" + fresh + "/unbind", { method: "POST", token: ADMIN_TOKEN, body: {} })
  );
  assert.equal(notYet.status, 409);
  assert.equal(notYet.data.reason, "not_bound");

  const unbound = await read(
    await call("/admin/offline/" + serial + "/unbind", { method: "POST", token: ISSUE_TOKEN, body: {} })
  );
  assert.equal(unbound.status, 200);
  assert.equal(unbound.data.license.bound_machine, "");
  assert.equal(unbound.data.license.previous_machine, undefined);
  const afterUnbind = JSON.parse(await kv.get("offline:" + serial));
  assert.equal(afterUnbind.previous_machine, MACHINE_A);
  assert.equal(afterUnbind.unbind_count, 1);

  const moved = await read(await call("/offline/report", { method: "POST", body: { serial, machine_code: MACHINE_B } }));
  assert.equal(moved.data.bound, true);
  assert.equal(JSON.parse(await kv.get("offline:" + serial)).bound_machine, MACHINE_B);
});

test("写死机器码的码不能解绑", async () => {
  const issued = await issue({ body: { machines: [MACHINE_A], note: "解绑拒绝" } });
  const serial = issued.data.issued[0].serial;
  const denied = await read(
    await call("/admin/offline/" + serial + "/unbind", { method: "POST", token: ISSUE_TOKEN, body: {} })
  );
  assert.equal(denied.status, 409);
  assert.equal(denied.data.reason, "machine_in_code");
});

test("台账能按买家机器码搜到批量码", async () => {
  const search = await read(await call("/admin/offline?q=" + MACHINE_B, { token: ADMIN_TOKEN }));
  const hit = search.data.licenses.find((r) => r.note === "首绑流程");
  assert.ok(hit, "批量码绑定后应能按机器码搜到");
  assert.equal(hit.bound_machine, MACHINE_B);
  assert.equal(hit.machine, "", "批量码签名里没有机器码");
});

test("离线列表：摘要、搜索、不吞元数据键", async () => {
  const list = await read(await call("/admin/offline", { token: ADMIN_TOKEN }));
  assert.equal(list.status, 200);
  assert.ok(list.data.summary.total >= 6);
  assert.ok(list.data.licenses.every((r) => typeof r.serial === "number"));
  assert.ok(!list.data.licenses.some((r) => String(r.code).includes("meta:")));

  const search = await read(await call("/admin/offline?q=吊销流程", { token: ADMIN_TOKEN }));
  assert.equal(search.data.licenses.length, 1);

  const byMachine = await read(await call("/admin/offline?q=" + MACHINE_B, { token: ADMIN_TOKEN }));
  assert.ok(byMachine.data.licenses.length >= 1);

  const onlineList = await read(await call("/admin/licenses", { token: ADMIN_TOKEN }));
  assert.equal(onlineList.data.summary.total, 0, "离线记录不应混进在线卡密列表");
});

test("签发接口限流更严", async () => {
  const ip = "198.51.100.9";
  const derived_key = await derivedKeyB64();
  let limitedAt = 0;
  for (let i = 1; i <= 12; i++) {
    const response = await call("/offline/issue", {
      method: "POST",
      token: ISSUE_TOKEN,
      ip,
      body: { derived_key, machines: [MACHINE_A] },
    });
    if (response.status === 429) { limitedAt = i; break; }
    await response.json();
  }
  assert.equal(limitedAt, 6, "RATE_ISSUE=5，第 6 次应被挡下");
});

test("health 报告私钥是否就绪", async () => {
  const ready = await read(await call("/health"));
  assert.equal(ready.data.offline_ready, true);
  const response = await worker.fetch(new Request("https://license.test/health"), { LICENSES: kv, ADMIN_TOKEN });
  const data = await response.json();
  assert.equal(data.offline_ready, false);
});

test("offline/params 给出派生密钥所需的 salt，且需要令牌", async () => {
  const denied = await read(await call("/offline/params"));
  assert.equal(denied.status, 401);
  const { status, data } = await read(await call("/offline/params", { token: ISSUE_TOKEN }));
  assert.equal(status, 200);
  assert.equal(data.kdf, "pbkdf2-sha256");
  assert.equal(data.iterations, blob.iterations);
  assert.equal(data.salt, blob.salt);
  assert.equal(data.ct, undefined, "不能把密文暴露给页面");
});

test("dry_run 只回显公钥，不写台账", async () => {
  const putsBefore = kv.puts;
  const { status, data } = await issue({ body: { dry_run: true } });
  assert.equal(status, 200);
  assert.equal(data.unlocked, true);
  assert.match(data.public_key, /^[0-9a-f]{64}$/);
  assert.equal(data.public_key, toHex(await publicKeyFromSeed(SEED)));
  assert.equal(kv.puts, putsBefore, "自检不该写 KV");
});

test("发卡台页面自带 CSP 且 noindex", async () => {
  const response = await call("/issue");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.equal(response.headers.get("robots"), "noindex, nofollow");
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  const text = await response.text();
  assert.match(text, /离线授权码/);
  assert.match(text, /在线卡密/);
  assert.match(text, /id="paneOnline"/);
  assert.ok(!text.includes("${"), "模板里不应残留未插值的占位符");
});

test("发卡台与说明页都带品牌图标", async () => {
  // 没有 favicon 时浏览器标签页显示通用地球图标，卖家的域名看着像别人的站
  for (const path of ["/issue", "/"]) {
    const response = await call(path);
    const text = await response.text();
    const icon = /<link rel="icon" href="([^"]+)">/.exec(text);
    assert.ok(icon, `${path} 缺少 rel="icon"`);
    assert.match(icon[1], /^data:image\/svg\+xml,%3Csvg/);
    assert.ok(text.includes("%23FF6B35"), `${path} 图标应使用面板同款橙色底`);
  }
});

test("发卡台内联脚本语法正确", async () => {
  // 发卡页整体靠这段脚本驱动，一个语法错误就是"点了没反应"，只能在这里拦住
  const script = /<script>([\s\S]*?)<\/script>/.exec(await (await call("/issue")).text());
  assert.ok(script, "发卡页应包含内联脚本");
  assert.doesNotThrow(() => new Function(script[1]), "内联脚本存在语法错误");
});
