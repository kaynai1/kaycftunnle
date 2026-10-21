// SPDX-License-Identifier: MIT
// 用内存 KV 模拟 Cloudflare KV，覆盖激活/校验/换绑/吊销全流程
import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/worker.js";
import { MemoryKV } from "../test-support/memory-kv.mjs";

const ADMIN_TOKEN = "test-admin-token";
const env = { LICENSES: new MemoryKV(), ADMIN_TOKEN };
let adminIpSeq = 0;

function call(path, { method = "GET", body, token, ip } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  // 管理接口按来源 IP 限流，各用例用自己的 IP，免得共享 "unknown" 桶被前面的用例耗尽
  headers["CF-Connecting-IP"] = ip || "203.0.112." + (adminIpSeq = (adminIpSeq + 1) % 250);
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
  const data = await response.json();
  return { status: response.status, data };
}

async function createOne(note = "测试") {
  const { data } = await read(
    await call("/admin/licenses", { method: "POST", token: ADMIN_TOKEN, body: { count: 1, note } })
  );
  return data.licenses[0];
}

test("health 无需鉴权", async () => {
  const { status, data } = await read(await call("/health"));
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.service, "kay-license");
});

test("根路径给人话说明，且不泄露接口", async () => {
  const response = await call("/");
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.ok(text.includes("授权校验服务"));
  for (const leak of ["/issue", "/admin", "/verify", "ISSUE_TOKEN", "KEY_BLOB"]) {
    assert.ok(!text.includes(leak), "根页面不该出现 " + leak);
  }
});

test("管理接口拒绝无令牌与错误令牌", async () => {
  assert.equal((await call("/admin/licenses")).status, 401);
  assert.equal((await call("/admin/licenses", { token: "wrong" })).status, 401);
});

test("ADMIN_TOKEN 未配置时返回 503", async () => {
  const response = await worker.fetch(
    new Request("https://license.test/admin/licenses"),
    { LICENSES: env.LICENSES }
  );
  assert.equal(response.status, 503);
});

test("生成卡密：格式、备注、列表摘要", async () => {
  const { status, data } = await read(
    await call("/admin/licenses", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { count: 3, note: "闲鱼批次 A" },
    })
  );
  assert.equal(status, 200);
  assert.equal(data.count, 3);
  for (const record of data.licenses) {
    assert.match(record.code, /^KAY-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.equal(record.note, "闲鱼批次 A");
    assert.equal(record.bound_machine, "");
    assert.equal(record.revoked, false);
  }
  const codes = new Set(data.licenses.map((r) => r.code));
  assert.equal(codes.size, 3);

  const list = await read(await call("/admin/licenses", { token: ADMIN_TOKEN }));
  assert.equal(list.data.summary.total, 3);
  assert.equal(list.data.summary.bound, 0);
});

test("激活与校验：绑定设备、幂等、拒绝换机", async () => {
  const record = await createOne("激活流程");
  const machineA = "NAS-AAAA-BBBB-CCCC";
  const machineB = "NAS-DDDD-EEEE-FFFF";

  const bad = await read(await call("/activate", { method: "POST", body: { code: "KAY-BAD", machine_code: machineA } }));
  assert.equal(bad.status, 400);
  assert.equal(bad.data.reason, "invalid_code");

  const missing = await read(
    await call("/activate", { method: "POST", body: { code: "KAY-0000-0000-0000", machine_code: machineA } })
  );
  assert.equal(missing.status, 404);

  // 小写、无连字符也能识别
  const flat = record.code.replace(/-/g, "").toLowerCase();
  const activated = await read(
    await call("/activate", { method: "POST", body: { code: flat, machine_code: machineA } })
  );
  assert.equal(activated.status, 200);
  assert.equal(activated.data.ok, true);
  assert.ok(activated.data.license.activated_at);

  const again = await read(
    await call("/activate", { method: "POST", body: { code: record.code, machine_code: machineA } })
  );
  assert.equal(again.status, 200);

  const other = await read(
    await call("/activate", { method: "POST", body: { code: record.code, machine_code: machineB } })
  );
  assert.equal(other.status, 409);
  assert.equal(other.data.reason, "device_mismatch");

  const verify = await read(
    await call("/verify", { method: "POST", body: { code: record.code, machine_code: machineA } })
  );
  assert.equal(verify.status, 200);
  assert.equal(verify.data.ok, true);
  assert.ok(verify.data.verified_at);

  const verifyOther = await read(
    await call("/verify", { method: "POST", body: { code: record.code, machine_code: machineB } })
  );
  assert.equal(verifyOther.status, 409);

  const detail = await read(
    await call("/admin/licenses/" + record.code, { token: ADMIN_TOKEN })
  );
  assert.equal(detail.data.license.bound_machine, machineA);
  assert.ok(detail.data.license.verify_count >= 3);
  assert.match(detail.data.license.bound_machine_hint, /CCCC$/);
});

test("吊销后激活与校验都被拒绝，恢复后可用", async () => {
  const record = await createOne("吊销流程");
  const machine = "NAS-1111-2222-3333";
  await call("/activate", { method: "POST", body: { code: record.code, machine_code: machine } });

  const revoked = await read(
    await call("/admin/licenses/" + record.code + "/revoke", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { revoked: true },
    })
  );
  assert.equal(revoked.data.license.revoked, true);

  const verify = await read(
    await call("/verify", { method: "POST", body: { code: record.code, machine_code: machine } })
  );
  assert.equal(verify.status, 403);
  assert.equal(verify.data.reason, "revoked");

  const activate = await read(
    await call("/activate", { method: "POST", body: { code: record.code, machine_code: machine } })
  );
  assert.equal(activate.status, 403);

  await call("/admin/licenses/" + record.code + "/revoke", {
    method: "POST",
    token: ADMIN_TOKEN,
    body: { revoked: false },
  });
  const restored = await read(
    await call("/verify", { method: "POST", body: { code: record.code, machine_code: machine } })
  );
  assert.equal(restored.status, 200);
});

test("解绑后可在新设备重新激活", async () => {
  const record = await createOne("换机流程");
  const oldMachine = "NAS-OLD0-0000-0001";
  const newMachine = "NAS-NEW0-0000-0002";
  await call("/activate", { method: "POST", body: { code: record.code, machine_code: oldMachine } });

  const unbound = await read(
    await call("/admin/licenses/" + record.code + "/unbind", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: {},
    })
  );
  assert.equal(unbound.status, 200);
  assert.equal(unbound.data.license.bound_machine, "");
  assert.equal(unbound.data.license.previous_machine, oldMachine);

  const verifyOld = await read(
    await call("/verify", { method: "POST", body: { code: record.code, machine_code: oldMachine } })
  );
  assert.equal(verifyOld.status, 409);
  assert.equal(verifyOld.data.reason, "not_activated");

  const activateNew = await read(
    await call("/activate", { method: "POST", body: { code: record.code, machine_code: newMachine } })
  );
  assert.equal(activateNew.status, 200);

  const verifyNew = await read(
    await call("/verify", { method: "POST", body: { code: record.code, machine_code: newMachine } })
  );
  assert.equal(verifyNew.status, 200);
});

test("搜索与未知路由", async () => {
  await createOne("独特关键词-ZETA");
  const found = await read(
    await call("/admin/licenses?q=ZETA", { token: ADMIN_TOKEN })
  );
  assert.equal(found.status, 200);
  assert.equal(found.data.licenses.length, 1);
  assert.equal(found.data.licenses[0].note, "独特关键词-ZETA");

  const unknown = await read(await call("/nope"));
  assert.equal(unknown.status, 404);
});

test("发卡令牌（ISSUE_TOKEN）也能批量出卡并管理台账", async () => {
  const issueEnv = { LICENSES: new MemoryKV(), ISSUE_TOKEN: "issue-only" };
  const hit = async (path, { method = "GET", body } = {}) => {
    const response = await worker.fetch(
      new Request("https://license.test" + path, {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer issue-only",
          "CF-Connecting-IP": "198.51.100.9",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      issueEnv
    );
    return { status: response.status, data: await response.json() };
  };

  const created = await hit("/admin/licenses", { method: "POST", body: { count: 3, note: "闲鱼批量" } });
  assert.equal(created.status, 200);
  assert.equal(created.data.count, 3);
  for (const record of created.data.licenses) {
    // 20 位以内、买家一眼能抄下来的短码
    assert.match(record.code, /^KAY-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.ok(record.code.length <= 20, "卡密必须短于 20 位");
    assert.equal(record.bound_machine, "", "出厂时不该绑任何设备");
    assert.equal(record.unbind_count, 0);
  }

  const first = created.data.licenses[0];
  const activated = await hit("/activate", {
    method: "POST",
    body: { code: first.code, machine_code: "NAS-1A1A-2B2B-3C3C" },
  });
  assert.equal(activated.status, 200);

  const list = await hit("/admin/licenses?q=NAS-1A1A");
  assert.equal(list.status, 200);
  assert.equal(list.data.licenses.length, 1);
  assert.equal(list.data.licenses[0].code, first.code);
  assert.equal(list.data.summary.bound, 1);

  const unbound = await hit("/admin/licenses/" + first.code + "/unbind", { method: "POST", body: {} });
  assert.equal(unbound.status, 200);
  assert.equal(unbound.data.license.bound_machine, "");
  assert.equal(unbound.data.license.unbind_count, 1);

  const wrongToken = await worker.fetch(
    new Request("https://license.test/admin/licenses", {
      headers: { Authorization: "Bearer nope", "CF-Connecting-IP": "198.51.100.10" },
    }),
    issueEnv
  );
  assert.equal(wrongToken.status, 401);
});

test("卡密换机：解绑后新设备自动绑上", async () => {
  const record = await createOne("换机计数-XI");
  const oldMachine = "NAS-OLD9-0000-0009";
  const newMachine = "NAS-NEW9-0000-0010";
  await call("/activate", { method: "POST", body: { code: record.code, machine_code: oldMachine } });

  const before = await read(await call("/admin/licenses?q=" + oldMachine, { token: ADMIN_TOKEN }));
  assert.equal(before.data.licenses.length, 1);
  assert.equal(before.data.licenses[0].bound_machine, oldMachine);

  await call("/admin/licenses/" + record.code + "/unbind", { method: "POST", token: ADMIN_TOKEN, body: {} });
  const after = await read(await call("/activate", {
    method: "POST", body: { code: record.code, machine_code: newMachine },
  }));
  assert.equal(after.status, 200);
  // 激活响应里不会回显买家机器码，绑定关系只在台账里给卖家看
  assert.equal(after.data.license.bound_machine, undefined);

  const ledger = await read(await call("/admin/licenses?q=XI", { token: ADMIN_TOKEN }));
  assert.equal(ledger.data.licenses[0].bound_machine, newMachine);
  assert.equal(ledger.data.licenses[0].unbind_count, 1);
  const rejected = await read(await call("/verify", {
    method: "POST", body: { code: record.code, machine_code: oldMachine },
  }));
  assert.equal(rejected.status, 409);
});

test("卡密台账只列 license: 记录，不吞编号水位与离线码", async () => {
  const record = await createOne("台账口径");
  await env.LICENSES.put("meta:offline_seq", String(Date.now()));
  await env.LICENSES.put(
    "offline:1760000000",
    JSON.stringify({ serial: 1760000000, code: "KAYO-AAAAA-BBBBB", note: "离线" })
  );
  const list = await read(await call("/admin/licenses", { token: ADMIN_TOKEN }));
  assert.equal(list.status, 200);
  assert.ok(list.data.licenses.length > 0);
  for (const item of list.data.licenses) {
    assert.match(item.code, /^KAY-/, "不能把编号水位或离线授权算进卡密台账");
  }
  assert.ok(list.data.licenses.some((item) => item.code === record.code));
});

test("公开接口按来源 IP 限流", async () => {
  const record = await createOne("限流");
  const ip = "203.0.113.77";
  const fire = () => worker.fetch(
    new Request("https://license.test/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ code: record.code, machine_code: "NAS-TEST-TEST-TSET" }),
    }),
    env
  );

  let hits = 0;
  let limitedAt = 0;
  for (let i = 1; i <= 90; i++) {
    const status = (await fire()).status;
    if (status === 429) { limitedAt = i; break; }
    if (status === 200) hits += 1;
  }
  assert.ok(limitedAt > 0, "应触发 429");
  assert.equal(hits, 60);

  const otherIp = await read(await call("/activate", {
    method: "POST", body: { code: record.code, machine_code: "NAS-TEST-TEST-TSET" }
  }));
  assert.notEqual(otherIp.status, 429);
});
