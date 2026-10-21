// SPDX-License-Identifier: MIT
// Kay-cftunnle 授权服务（Cloudflare Workers + KV）
//
// 在线卡密：KV key = license:<CODE>，value = LicenseRecord(JSON)
// 离线授权：KV key = offline:<SERIAL>，value = OfflineRecord(JSON)，签发时写入，面板每 6 小时报到一次
// 公开接口：POST /activate、POST /verify、POST /offline/report、GET /health
// 发卡接口：POST /offline/issue（需要 ISSUE_TOKEN + 浏览器派生的私钥密钥）
// 管理接口：/admin/licenses…、/admin/offline…，需要 Authorization: Bearer <ISSUE_TOKEN 或 ADMIN_TOKEN>

import { FLAG_ANY_MACHINE, FLAG_PERMANENT, issueOfflineLicense, packMachine, unpackMachine } from "./offline.mjs";
import { decryptSeedWithKey, fromB64, parseBlob, PBKDF2_ITERATIONS } from "./keywrap.mjs";
import { publicKeyFromSeed } from "./ed25519.mjs";
import { ISSUE_CONSOLE_HTML } from "./issue-console.mjs";

const CODE_PREFIX = "KAY";
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32，去掉 I L O U
const CODE_GROUPS = 3;
const CODE_GROUP_LEN = 4;
const MAX_BODY = 8 * 1024;
const PRODUCT = "kay-cftunnle";
const DAY = 86400;

// 单 isolate 的粗略限流：挡脚本刷接口；真正的洪水攻击请再配 Cloudflare 速率规则
const RATE_WINDOW_MS = 60 * 1000;
const RATE_PUBLIC = 60;
const RATE_ADMIN = 30;
const RATE_ISSUE = 5;
const RATE_TRACK_MAX = 4000;
const rateBuckets = new Map();

function rateLimited(key, max) {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start > RATE_WINDOW_MS) {
    if (rateBuckets.size >= RATE_TRACK_MAX) {
      for (const [k, v] of rateBuckets) {
        if (now - v.start > RATE_WINDOW_MS) rateBuckets.delete(k);
      }
    }
    rateBuckets.set(key, { start: now, count: 1 });
    return false;
  }
  bucket.count += 1;
  return bucket.count > max;
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      ...headers,
    },
  });
}

function fail(status, reason, error) {
  return json({ ok: false, reason, error }, status);
}

function html(text) {
  return new Response(text, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      robots: "noindex, nofollow",
      // 页面自带内联脚本，其余一律只认同源
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; " +
        "img-src data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}

function normalizeCode(raw) {
  const flat = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const body = flat.startsWith(CODE_PREFIX) ? flat.slice(CODE_PREFIX.length) : flat;
  if (body.length !== CODE_GROUPS * CODE_GROUP_LEN) return "";
  for (const ch of body) {
    if (!CODE_ALPHABET.includes(ch)) return "";
  }
  const groups = [];
  for (let i = 0; i < body.length; i += CODE_GROUP_LEN) {
    groups.push(body.slice(i, i + CODE_GROUP_LEN));
  }
  return CODE_PREFIX + "-" + groups.join("-");
}

function normalizeMachine(raw) {
  const value = String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
  if (value.length < 8 || value.length > 64) return "";
  if (!/^[A-Z0-9][A-Z0-9-]*[A-Z0-9]$/.test(value)) return "";
  return value;
}

function randomCode() {
  const bytes = new Uint8Array(CODE_GROUPS * CODE_GROUP_LEN);
  crypto.getRandomValues(bytes);
  let body = "";
  for (const byte of bytes) body += CODE_ALPHABET[byte % 32];
  const groups = [];
  for (let i = 0; i < body.length; i += CODE_GROUP_LEN) {
    groups.push(body.slice(i, i + CODE_GROUP_LEN));
  }
  return CODE_PREFIX + "-" + groups.join("-");
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function keyOf(code) {
  return "license:" + code;
}

async function readRecord(env, code) {
  const raw = await env.LICENSES.get(keyOf(code));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeRecord(env, record) {
  await env.LICENSES.put(keyOf(record.code), JSON.stringify(record), {
    metadata: {
      code: record.code,
      created_at: record.created_at,
      note: record.note || "",
      revoked: !!record.revoked,
      bound: !!record.bound_machine,
    },
  });
}

function publicView(record) {
  return {
    code: record.code,
    product: record.product,
    activated_at: record.activated_at || null,
    bound_at: record.bound_at || null,
    revoked: !!record.revoked,
  };
}

function adminView(record, origin) {
  return {
    ...record,
    bound_machine_hint: record.bound_machine ? "…" + record.bound_machine.slice(-4) : "",
    verify_url: origin,
  };
}

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "";
}

function timingSafeEqual(a, b) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    diff |= (left[i] || 0) ^ (right[i] || 0);
  }
  return diff === 0;
}

function isAdmin(request, env) {
  const token = String(env.ADMIN_TOKEN || "").trim();
  if (!token) return false;
  const header = request.headers.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return !!match && timingSafeEqual(match[1].trim(), token);
}

// ------------------------------------------------------------------ 公开接口

async function handleActivate(request, env) {
  const body = await readJson(request);
  if (body === null) return fail(400, "bad_request", "请求体不是合法 JSON");
  const code = normalizeCode(body.code);
  const machine = normalizeMachine(body.machine_code);
  if (!code) return fail(400, "invalid_code", "卡密格式不正确，应形如 KAY-XXXX-XXXX-XXXX");
  if (!machine) return fail(400, "invalid_machine", "机器码格式不正确");

  const record = await readRecord(env, code);
  if (!record) return fail(404, "not_found", "卡密不存在，请检查是否输入有误");
  if (record.revoked) return fail(403, "revoked", "该卡密已被吊销");
  if (record.bound_machine && record.bound_machine !== machine) {
    return fail(409, "device_mismatch", "该卡密已绑定其他设备，请联系管理员解绑后再激活");
  }

  const ts = nowSec();
  if (!record.bound_machine) {
    record.bound_machine = machine;
    record.bound_at = ts;
    record.activated_at = record.activated_at || ts;
  }
  record.last_machine = machine;
  record.last_verify_at = ts;
  record.last_ip = clientIp(request);
  record.verify_count = (record.verify_count || 0) + 1;
  record.updated_at = ts;
  await writeRecord(env, record);

  return json({
    ok: true,
    product: PRODUCT,
    license: publicView(record),
    message: "激活成功，已绑定当前设备",
  });
}

async function handleVerify(request, env) {
  const body = await readJson(request);
  if (body === null) return fail(400, "bad_request", "请求体不是合法 JSON");
  const code = normalizeCode(body.code);
  const machine = normalizeMachine(body.machine_code);
  if (!code) return fail(400, "invalid_code", "卡密格式不正确");
  if (!machine) return fail(400, "invalid_machine", "机器码格式不正确");

  const record = await readRecord(env, code);
  if (!record) return fail(404, "not_found", "卡密不存在");
  if (record.revoked) return fail(403, "revoked", "该卡密已被吊销");
  if (!record.bound_machine) return fail(409, "not_activated", "该卡密尚未激活");
  if (record.bound_machine !== machine) {
    return fail(409, "device_mismatch", "设备与卡密绑定信息不一致");
  }

  const ts = nowSec();
  record.last_machine = machine;
  record.last_verify_at = ts;
  record.last_ip = clientIp(request);
  record.verify_count = (record.verify_count || 0) + 1;
  record.updated_at = ts;
  await writeRecord(env, record);

  return json({
    ok: true,
    product: PRODUCT,
    license: publicView(record),
    verified_at: ts,
  });
}

// ------------------------------------------------------------------ 离线授权：记录

const SERIAL_MAX = 4294967295;
const SEQ_KEY = "meta:offline_seq";
// 面板每 6 小时报到一次，短时间重复报到不再写 KV，省配额
const REPORT_WRITE_WINDOW = 5 * 60;

function offlineKeyOf(serial) {
  return "offline:" + serial;
}

function normalizeSerial(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > SERIAL_MAX) return 0;
  return value;
}

async function readOfflineRecord(env, serial) {
  const raw = await env.LICENSES.get(offlineKeyOf(serial));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeOfflineRecord(env, record) {
  await env.LICENSES.put(offlineKeyOf(record.serial), JSON.stringify(record), {
    metadata: {
      serial: record.serial,
      machine: record.machine || "",
      note: record.note || "",
      revoked: !!record.revoked,
      expires_at: record.expires_at || 0,
      last_report_at: record.last_report_at || 0,
    },
  });
}

function offlineView(record) {
  const bound = record.bound_machine || record.machine || "";
  return {
    serial: record.serial,
    code: record.code,
    machine: bound,
    expires_at: record.expires_at || 0,
    issued_at: record.issued_at || record.created_at || 0,
    note: record.note || "",
    revoked: !!record.revoked,
    bound_machine: bound,
    bound_at: record.bound_at || null,
    auto_bound: !!bound && !record.machine,
    last_report_at: record.last_report_at || null,
    report_count: record.report_count || 0,
    unbind_count: record.unbind_count || 0,
    unbindable: !record.machine && !!bound,
  };
}

function packMachineSafe(raw) {
  const value = normalizeMachine(raw);
  if (!value) return "";
  try {
    return unpackMachine(packMachine(value));
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------ 离线授权：公开接口

async function handleOfflineReport(request, env) {
  const body = await readJson(request);
  if (body === null) return fail(400, "bad_request", "请求体不是合法 JSON");
  const serial = normalizeSerial(body.serial);
  if (!serial) return fail(400, "invalid_serial", "授权编号格式不正确");
  const rawMachine = normalizeMachine(body.machine_code);
  // 统一成签名里的写法，避免大小写或分隔符差异把同一台机器误判成换机
  const machine = rawMachine ? packMachineSafe(rawMachine) || rawMachine : "";
  const ts = nowSec();

  const record = await readOfflineRecord(env, serial);
  // 服务端没有这张授权码的台账（比如卖家在别处签发），不能因此锁机——本地签名才是判据
  if (!record) return json({ ok: true, known: false, revoked: false, reported_at: ts });

  if (record.revoked) {
    record.last_report_at = ts;
    record.last_ip = clientIp(request);
    record.updated_at = ts;
    await writeOfflineRecord(env, record);
    // ok 表示"这次报到处理成功了"，结论放在 revoked / device_mismatch 标志里：
    // 面板的客户端对 ok:false 一律当作"没问到结果"，不会据此锁机
    return json({ ok: true, known: true, revoked: true, reported_at: ts, error: "该离线授权已被吊销" });
  }

  const changed = !!machine && machine !== record.last_machine;
  const stale = !record.last_report_at || ts - record.last_report_at >= REPORT_WRITE_WINDOW;
  const bound = record.bound_machine || record.machine || "";

  // 批量预生成的码没有内置机器，买家首次报到时由这里认领设备；
  // 本地签名只校验"任意机器"标志，绑定关系只能靠服务端维持
  if (!bound && machine) {
    record.bound_machine = machine;
    record.bound_at = ts;
    record.first_machine = machine;
    record.last_machine = machine;
    record.last_report_at = ts;
    record.last_ip = clientIp(request);
    record.report_count = (record.report_count || 0) + 1;
    record.updated_at = ts;
    await writeOfflineRecord(env, record);
    return json({
      ok: true,
      known: true,
      revoked: false,
      bound: true,
      reported_at: ts,
      expires_at: record.expires_at || 0,
    });
  }

  if (bound && machine && machine !== bound) {
    record.mismatch_count = (record.mismatch_count || 0) + 1;
    record.last_report_at = ts;
    record.last_ip = clientIp(request);
    record.updated_at = ts;
    await writeOfflineRecord(env, record);
    return json({
      ok: true,
      known: true,
      revoked: false,
      device_mismatch: true,
      reported_at: ts,
      error: "该授权码已绑定其他设备，如需换机请联系卖家解绑",
    });
  }

  if (changed || stale) {
    if (!record.first_machine && machine) record.first_machine = machine;
    if (changed && record.last_machine) record.machine_changed_at = ts;
    if (machine) record.last_machine = machine;
    record.last_report_at = ts;
    record.last_ip = clientIp(request);
    record.report_count = (record.report_count || 0) + 1;
    record.updated_at = ts;
    await writeOfflineRecord(env, record);
  }

  return json({
    ok: true,
    known: true,
    revoked: false,
    reported_at: ts,
    expires_at: record.expires_at || 0,
  });
}

// ------------------------------------------------------------------ 离线授权：发卡接口

function hasIssueAuth(request, env) {
  const token = String(env.ISSUE_TOKEN || "").trim();
  if (!token) return false;
  const match = /^Bearer\s+(.+)$/i.exec((request.headers.get("Authorization") || "").trim());
  return !!match && timingSafeEqual(match[1].trim(), token);
}

function requireIssue(request, env) {
  if (!String(env.ISSUE_TOKEN || "").trim()) {
    return fail(503, "issue_not_configured", "服务端未设置 ISSUE_TOKEN，请先执行 wrangler secret put ISSUE_TOKEN");
  }
  if (!String(env.KEY_BLOB || "").trim()) {
    return fail(503, "key_not_configured", "服务端未设置 KEY_BLOB，请先执行 wrangler secret put KEY_BLOB");
  }
  if (!hasIssueAuth(request, env)) {
    return fail(401, "unauthorized", "发卡令牌无效");
  }
  return null;
}

// 发卡页需要 salt 与迭代次数才能在浏览器里派生出同一把 AES 密钥；
// 这两项都不是秘密（salt 只用于防预计算），但仍要 ISSUE_TOKEN 才给。
async function handleOfflineParams(request, env) {
  const denied = requireIssue(request, env);
  if (denied) return denied;
  let parsed;
  try {
    parsed = parseBlob(env.KEY_BLOB);
  } catch {
    return fail(500, "key_blob_invalid", "KEY_BLOB 不是合法的私钥密文，请重新执行 wrangler secret put KEY_BLOB");
  }
  return json({
    ok: true,
    v: parsed.v,
    kdf: parsed.kdf || "pbkdf2-sha256",
    cipher: parsed.cipher || "aes-256-gcm",
    salt: parsed.salt,
    iterations: Math.max(1000, Math.min(2000000, Number(parsed.iterations) || PBKDF2_ITERATIONS)),
  });
}

async function importDerivedKey(derivedKeyB64) {
  const bytes = fromB64(String(derivedKeyB64 || ""));
  if (bytes.length !== 32) throw new Error("派生密钥长度异常");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["decrypt"]);
}

async function nextSerialBase(env, count) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const last = normalizeSerial(await env.LICENSES.get(SEQ_KEY));
    const base = Math.max(nowSec(), last + 1);
    const end = base + count - 1;
    if (end > SERIAL_MAX) throw new Error("授权编号已用尽");
    await env.LICENSES.put(SEQ_KEY, String(end));
    // 本地签发工具（tools/issue.mjs）拿同一秒的时间戳当编号，撞上就整段往后让
    if (await readOfflineRecord(env, base)) continue;
    return base;
  }
  throw new Error("授权编号分配失败，请重试");
}

async function handleOfflineIssue(request, env) {
  const denied = requireIssue(request, env);
  if (denied) return denied;
  const body = await readJson(request);
  if (body === null) return fail(400, "bad_request", "请求体不是合法 JSON");

  const permanent = body.permanent === true;
  const days = Math.min(Math.max(parseInt(body.days, 10) || 365, 1), 3650);

  let seed;
  try {
    // 派生密钥由发卡页在浏览器里用 PBKDF2 算出，Worker 只做一次 AES-GCM 解密：
    // 口令不上网，边缘也不算 31 万次哈希
    const key = await importDerivedKey(body.derived_key);
    seed = await decryptSeedWithKey(env.KEY_BLOB, key);
  } catch {
    return fail(400, "key_unwrap_failed", "私钥口令不正确");
  }

  // dry_run：只验证口令能否解开私钥，并回显对应公钥（部署时用它拿 OFFLINE_PUBLIC_KEY）
  if (body.dry_run === true) {
    const publicKey = await publicKeyFromSeed(seed);
    const hex = Array.from(publicKey, (b) => b.toString(16).padStart(2, "0")).join("");
    seed.fill(0);
    return json({ ok: true, unlocked: true, public_key: hex });
  }

  const anyMachine = body.any_machine === true;
  const machines = [];
  if (!anyMachine) {
    const input = Array.isArray(body.machines) ? body.machines : String(body.machines || "").split(/[\s,;]+/);
    for (const item of input) {
      if (!String(item || "").trim()) continue;
      const packed = packMachineSafe(item);
      if (!packed) return fail(400, "invalid_machine", "机器码格式不正确：" + String(item).trim().slice(0, 40));
      if (!machines.includes(packed)) machines.push(packed);
    }
    if (!machines.length) return fail(400, "invalid_machine", "请至少填写一个机器码");
  }
  // 不绑定机器的码用于批量预生成（挂闲鱼自动发货），买家首次激活时由报到接口自动绑定
  const count = anyMachine ? Math.max(parseInt(body.count, 10) || 1, 1) : machines.length;
  if (count > 100) {
    seed.fill(0);
    return fail(400, "too_many", "一次最多签发 100 张");
  }

  const note = String(body.note || "").trim().slice(0, 120);
  const issuedAt = nowSec();
  const expiresAt = permanent ? 0 : issuedAt + days * DAY;
  let base;
  try {
    base = await nextSerialBase(env, count);
  } catch (err) {
    return fail(500, "serial_exhausted", String(err && err.message ? err.message : "授权编号分配失败"));
  }

  const created = [];
  for (let i = 0; i < count; i++) {
    const serial = base + i;
    const machine = anyMachine ? "" : machines[i];
    const flags = (machine ? 0 : FLAG_ANY_MACHINE) | (permanent ? FLAG_PERMANENT : 0);
    let code;
    try {
      code = await issueOfflineLicense(seed, { flags, machine, serial, issuedAt, expiresAt });
    } catch (err) {
      return fail(500, "sign_failed", "签发失败：" + String(err && err.message ? err.message : "未知错误"));
    }
    const record = {
      serial,
      code,
      product: PRODUCT,
      note,
      machine,
      flags,
      issued_at: issuedAt,
      expires_at: expiresAt,
      created_at: issuedAt,
      updated_at: issuedAt,
      first_machine: "",
      last_machine: "",
      bound_machine: machine,
      bound_at: machine ? issuedAt : null,
      unbind_count: 0,
      last_report_at: null,
      report_count: 0,
      last_ip: "",
      revoked: false,
      revoked_at: null,
    };
    await writeOfflineRecord(env, record);
    created.push(record);
  }

  // 种子用完即弃：清空白键引用，避免在 isolate 里长期驻留
  seed.fill(0);
  return json({
    ok: true,
    count: created.length,
    days: permanent ? 0 : days,
    expires_at: expiresAt,
    issued: created.map(offlineView),
  });
}

// ------------------------------------------------------------------ 管理接口

async function listLicenses(request, env, url) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 1), 1000);
  const query = String(url.searchParams.get("q") || "").trim().toUpperCase();
  const keys = [];
  let cursor;
  while (keys.length < 1000) {
    const page = await env.LICENSES.list({ prefix: "license:", cursor, limit: 1000 });
    for (const key of page.keys) keys.push(key.name);
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  const records = [];
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const values = await Promise.all(chunk.map((name) => env.LICENSES.get(name)));
    for (let j = 0; j < chunk.length; j++) {
      if (!values[j]) continue;
      try {
        const record = JSON.parse(values[j]);
        if (query) {
          const hay = [record.code, record.note, record.bound_machine, record.last_machine].join(" ").toUpperCase();
          if (!hay.includes(query)) continue;
        }
        records.push(record);
      } catch {
        // 跳过损坏的记录，避免一条坏数据拖垮整个列表
      }
    }
  }
  records.sort((a, b) => (b.created_at || 0) - (a.created_at || 0) || a.code.localeCompare(b.code));
  const summary = {
    total: records.length,
    bound: records.filter((r) => r.bound_machine).length,
    revoked: records.filter((r) => r.revoked).length,
  };
  return json({ ok: true, summary, licenses: records.slice(0, limit) });
}

async function createLicenses(request, env) {
  const body = await readJson(request);
  if (body === null) return fail(400, "bad_request", "请求体不是合法 JSON");
  const count = Math.min(Math.max(parseInt(body.count, 10) || 1, 1), 100);
  const note = String(body.note || "").trim().slice(0, 120);
  const created = [];
  const ts = nowSec();
  // 冲突概率极低（60 bit），仍做一次存在性检查，保证发出的码一定唯一
  for (let i = 0; i < count; i++) {
    let code = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = randomCode();
      if (!(await env.LICENSES.get(keyOf(candidate)))) {
        code = candidate;
        break;
      }
    }
    if (!code) return fail(500, "code_collision", "生成卡密失败，请重试");
    const record = {
      code,
      product: PRODUCT,
      note,
      created_at: ts,
      updated_at: ts,
      bound_machine: "",
      bound_at: null,
      activated_at: null,
      last_machine: "",
      last_verify_at: null,
      last_ip: "",
      verify_count: 0,
      unbind_count: 0,
      revoked: false,
      revoked_at: null,
    };
    await writeRecord(env, record);
    created.push(record);
  }
  return json({ ok: true, count: created.length, licenses: created });
}

async function listOffline(request, env, url) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 1), 1000);
  const query = String(url.searchParams.get("q") || "").trim().toUpperCase();
  const keys = [];
  let cursor;
  while (keys.length < 1000) {
    const page = await env.LICENSES.list({ prefix: "offline:", cursor, limit: 1000 });
    for (const key of page.keys) keys.push(key.name);
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  const records = [];
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const values = await Promise.all(chunk.map((name) => env.LICENSES.get(name)));
    for (let j = 0; j < chunk.length; j++) {
      if (!values[j]) continue;
      try {
        const record = JSON.parse(values[j]);
        if (!record || typeof record !== "object") continue;
        if (query) {
          const hay = [record.serial, record.code, record.machine, record.bound_machine, record.note].join(" ").toUpperCase();
          if (!hay.includes(query)) continue;
        }
        records.push(record);
      } catch {
        // 跳过损坏的记录，避免一条坏数据拖垮整个列表
      }
    }
  }
  records.sort((a, b) => (b.serial || 0) - (a.serial || 0));
  const now = nowSec();
  const summary = {
    total: records.length,
    revoked: records.filter((r) => r.revoked).length,
    reported: records.filter((r) => r.last_report_at).length,
    expiring: records.filter((r) => !r.revoked && r.expires_at && r.expires_at - now < 30 * DAY).length,
  };
  return json({ ok: true, summary, licenses: records.slice(0, limit) });
}

function serialFromPath(path, suffix = "") {
  const pattern = suffix
    ? new RegExp("^/admin/offline/(\\d+)/" + suffix + "$")
    : /^\/admin\/offline\/(\d+)$/;
  const match = pattern.exec(path);
  return match ? normalizeSerial(match[1]) : 0;
}

// 管理接口共用的闸门：发卡台只持有 ISSUE_TOKEN，也要能管卡密和离线台账
function requireOfflineManager(request, env) {
  const adminSet = !!String(env.ADMIN_TOKEN || "").trim();
  const issueSet = !!String(env.ISSUE_TOKEN || "").trim();
  if (!adminSet && !issueSet) {
    return fail(503, "admin_not_configured", "服务端未设置 ADMIN_TOKEN / ISSUE_TOKEN");
  }
  if ((adminSet && isAdmin(request, env)) || (issueSet && hasIssueAuth(request, env))) return null;
  return fail(401, "unauthorized", "令牌无效");
}

async function handleAdminOffline(request, env, url, path, method) {
  const denied = requireOfflineManager(request, env);
  if (denied) return denied;
  if (path === "/admin/offline" && method === "GET") {
    return listOffline(request, env, url);
  }
  if (path === "/admin/offline" || !path.startsWith("/admin/offline/")) {
    return fail(404, "not_found", "管理接口不存在");
  }

  const action = path.endsWith("/revoke") ? "revoke" : path.endsWith("/unbind") ? "unbind" : "";
  const serial = action ? serialFromPath(path, action) : serialFromPath(path);
  if (!serial) return fail(400, "invalid_serial", "授权编号格式不正确");
  const record = await readOfflineRecord(env, serial);
  if (!record) return fail(404, "not_found", "没有这张离线授权的签发记录");

  if (method === "GET") {
    if (action) return fail(404, "not_found", "管理接口不存在");
    return json({ ok: true, license: { ...record, verify_url: url.origin } });
  }
  if (!action) return fail(404, "not_found", "管理接口不存在");

  const body = await readJson(request);
  if (body === null) return fail(400, "bad_request", "请求体不是合法 JSON");
  const ts = nowSec();

  if (action === "unbind") {
    // 签发时把机器码写进签名的码解不了绑——本地校验会先拒绝，只能重签
    if (record.machine) return fail(409, "machine_in_code", "这张码签发时写死了机器码，无法解绑，请重新签发");
    if (!record.bound_machine) return fail(409, "not_bound", "该授权码当前没有绑定设备");
    record.previous_machine = record.bound_machine;
    record.bound_machine = "";
    record.bound_at = null;
    record.first_machine = "";
    record.last_machine = "";
    record.mismatch_count = 0;
    record.unbind_count = (record.unbind_count || 0) + 1;
    record.updated_at = ts;
    await writeOfflineRecord(env, record);
    return json({
      ok: true,
      license: offlineView(record),
      message: "已解绑，买家的新设备下次报到时会自动绑上",
    });
  }

  const revoked = body.revoked === undefined ? true : !!body.revoked;
  record.revoked = revoked;
  record.revoked_at = revoked ? ts : null;
  record.updated_at = ts;
  await writeOfflineRecord(env, record);
  return json({
    ok: true,
    license: offlineView(record),
    message: revoked ? "已吊销，面板下次报到时会锁定" : "已恢复",
  });
}

function codeFromPath(path, suffix = "") {
  const pattern = suffix
    ? new RegExp("^/admin/licenses/([^/]+)/" + suffix + "$")
    : /^\/admin\/licenses\/([^/]+)$/;
  const match = pattern.exec(path);
  return match ? normalizeCode(decodeURIComponent(match[1])) : "";
}

// 发卡台（ISSUE_TOKEN）也能管卡密：买家机器码、解绑、吊销都在同一张台账里维护
async function handleAdmin(request, env, url) {
  const denied = requireOfflineManager(request, env);
  if (denied) return denied;
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;

  if (path === "/admin/licenses" && method === "GET") {
    return listLicenses(request, env, url);
  }
  if (path === "/admin/licenses" && method === "POST") {
    return createLicenses(request, env);
  }
  if (path.startsWith("/admin/licenses/") && method === "GET") {
    const code = codeFromPath(path);
    if (!code) return fail(400, "invalid_code", "卡密格式不正确");
    const record = await readRecord(env, code);
    if (!record) return fail(404, "not_found", "卡密不存在");
    return json({ ok: true, license: adminView(record, url.origin) });
  }
  if (path.startsWith("/admin/licenses/") && method === "POST") {
    const action = path.endsWith("/revoke") ? "revoke" : path.endsWith("/unbind") ? "unbind" : "";
    if (!action) return fail(404, "not_found", "管理接口不存在");
    const code = codeFromPath(path, action);
    if (!code) return fail(400, "invalid_code", "卡密格式不正确");
    const record = await readRecord(env, code);
    if (!record) return fail(404, "not_found", "卡密不存在");
    const body = await readJson(request);
    if (body === null) return fail(400, "bad_request", "请求体不是合法 JSON");
    const ts = nowSec();

    if (action === "revoke") {
      const revoked = body.revoked === undefined ? true : !!body.revoked;
      record.revoked = revoked;
      record.revoked_at = revoked ? ts : null;
      record.updated_at = ts;
      await writeRecord(env, record);
      return json({ ok: true, license: adminView(record, url.origin), message: revoked ? "已吊销" : "已恢复" });
    }

    if (!record.bound_machine) {
      return fail(409, "not_bound", "该卡密当前没有绑定设备");
    }
    record.previous_machine = record.bound_machine;
    record.bound_machine = "";
    record.bound_at = null;
    record.last_machine = "";
    record.unbind_count = (record.unbind_count || 0) + 1;
    record.updated_at = ts;
    await writeRecord(env, record);
    return json({
      ok: true,
      license: adminView(record, url.origin),
      message: "已解绑，下一台设备可用同一卡密激活",
    });
  }

  return fail(404, "not_found", "管理接口不存在");
}

// ------------------------------------------------------------------ 入口

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "GET" && path === "/") {
      // 面向误访问的买家：只给一句人话，不暴露发卡台和其他端点
      return html(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23FF6B35'/%3E%3Cpath d='M6 27V15a10 10 0 0 1 20 0v12h-5V15a5 5 0 0 0-10 0v12H6Z' fill='%231C1917'/%3E%3C/svg%3E">
<title>授权校验服务</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;
 background:#0d0f14;color:#e8eaf0;font:16px/1.75 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
.card{max-width:34em;padding:34px 32px;border:1px solid #232838;border-radius:16px;
 background:linear-gradient(180deg,#151824,#101219);box-shadow:0 24px 60px rgba(0,0,0,.45)}
h1{margin:0 0 6px;font-size:19px;letter-spacing:.02em}
p{margin:14px 0 0;color:#a7afc4}
.tag{display:inline-block;padding:3px 10px;border-radius:999px;background:#1d2333;
 color:#7f8aa6;font-size:12px;letter-spacing:.08em}
code{padding:2px 6px;border-radius:6px;background:#1d2333;color:#c9d2e6;font-size:14px}
</style></head><body><div class="card">
<span class="tag">KAY-CFTUNNLE</span>
<h1 style="margin-top:14px">这里是面板的授权校验服务</h1>
<p>你不需要直接打开这个网址。<b>激活请在面板里完成</b>：浏览器访问 <code>http://你的NAS地址:8567</code>，会自动跳到激活页，按提示填入卖家发给你的授权码即可。</p>
<p>如果面板打不开、或激活提示无法连接本服务，请把情况截图发给卖家处理。</p>
</div></body></html>`);
    }
    if (request.method === "GET" && path === "/health") {
      return json({
        ok: true,
        service: "kay-license",
        product: PRODUCT,
        time: nowSec(),
        offline_ready: !!String(env.KEY_BLOB || "").trim(),
      });
    }
    if (!env.LICENSES) {
      return fail(503, "kv_not_configured", "KV 未绑定：请在 wrangler.toml 中配置 LICENSES");
    }
    const ip = clientIp(request) || "unknown";
    if (request.method === "POST" && (path === "/activate" || path === "/verify" || path === "/offline/report")) {
      if (rateLimited("p:" + ip, RATE_PUBLIC)) {
        return fail(429, "rate_limited", "请求过于频繁，请稍后再试");
      }
    }
    if (path === "/issue" && request.method === "GET") {
      return html(ISSUE_CONSOLE_HTML);
    }
    if (path.startsWith("/admin/offline")) {
      if (rateLimited("a:" + ip, RATE_ADMIN)) {
        return fail(429, "rate_limited", "管理接口请求过于频繁，请稍后再试");
      }
      return handleAdminOffline(request, env, url, path, request.method);
    }
    if (path.startsWith("/admin/")) {
      if (rateLimited("a:" + ip, RATE_ADMIN)) {
        return fail(429, "rate_limited", "管理接口请求过于频繁，请稍后再试");
      }
      return handleAdmin(request, env, url);
    }
    if (request.method === "POST" && path === "/activate") {
      return handleActivate(request, env);
    }
    if (request.method === "POST" && path === "/verify") {
      return handleVerify(request, env);
    }
    if (request.method === "POST" && path === "/offline/report") {
      return handleOfflineReport(request, env);
    }
    if (request.method === "GET" && path === "/offline/params") {
      if (rateLimited("i:" + ip, RATE_ISSUE)) {
        return fail(429, "rate_limited", "发卡接口请求过于频繁，请稍后再试");
      }
      return handleOfflineParams(request, env);
    }
    if (request.method === "POST" && path === "/offline/issue") {
      if (rateLimited("i:" + ip, RATE_ISSUE)) {
        return fail(429, "rate_limited", "签发接口请求过于频繁，请稍后再试");
      }
      return handleOfflineIssue(request, env);
    }
    return fail(404, "not_found", "接口不存在");
  },
};
