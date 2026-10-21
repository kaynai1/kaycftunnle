// 离线签发私钥的口令封装：私钥种子只以 PBKDF2 + AES-256-GCM 密文形式存在。
// 同一份密文 blob 既给本地签发工具（tools/issue.mjs）用，也作为 Worker secret KEY_BLOB 用；
// 解开它需要口令，口令只在售卖者脑子里，因此 blob 泄露不等于私钥泄露。

const text = new TextEncoder();

export const KEYWRAP_VERSION = 1;
export const PBKDF2_ITERATIONS = 310000;

function toB64(bytes) {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}

function fromB64(value) {
  const s = atob(String(value || ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveKey(passphrase, salt, iterations) {
  return deriveAesKey(passphrase, salt, iterations, false);
}

/** 口令 → AES-256-GCM 密钥。extractable=true 时调用方可导出原始字节（发卡页在浏览器里派生后只上传派生密钥）。 */
export async function deriveAesKey(passphrase, salt, iterations, extractable = false) {
  const base = await crypto.subtle.importKey("raw", text.encode(String(passphrase)), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    extractable,
    ["encrypt", "decrypt"]
  );
}

export function parseBlob(blob) {
  const parsed = typeof blob === "string" ? JSON.parse(blob) : blob;
  if (!parsed || parsed.v !== KEYWRAP_VERSION || !parsed.salt || !parsed.iv || !parsed.ct) {
    throw new Error("私钥密文格式不正确");
  }
  return parsed;
}

/** 用已派生的 AES-GCM 密钥解开 blob（Worker 走这条路，避免在边缘做 PBKDF2）。 */
export async function decryptSeedWithKey(blob, key) {
  const parsed = parseBlob(blob);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(parsed.iv) }, key, fromB64(parsed.ct));
  const seed = new Uint8Array(plain);
  if (seed.length !== 32) throw new Error("私钥种子长度异常");
  return seed;
}

/** 用口令解开 blob，得到种子字节；口令错误或 blob 被篡改时抛错。 */
export async function decryptSeed(blob, passphrase) {
  const parsed = parseBlob(blob);
  const key = await deriveKey(
    passphrase,
    fromB64(parsed.salt),
    Math.max(1000, Math.min(2000000, Number(parsed.iterations) || PBKDF2_ITERATIONS))
  );
  return decryptSeedWithKey(parsed, key);
}

export { toB64, fromB64 };

/** 用口令加密 32 字节种子，返回可直接 JSON 序列化的 blob。 */
export async function encryptSeed(seed, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, seed);
  return {
    v: KEYWRAP_VERSION,
    kdf: "pbkdf2-sha256",
    cipher: "aes-256-gcm",
    iterations: PBKDF2_ITERATIONS,
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(new Uint8Array(ct)),
  };
}
