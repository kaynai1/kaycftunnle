// 离线授权码格式：22 字节载荷 + 64 字节 Ed25519 签名 = 86 字节，
// 用 Crockford Base32 编码并按 5 位分组，前缀 KAYO。
// 面板侧的解析与验签在 license.py，两边字段布局必须完全一致。
//
//   偏移  长度  字段
//   0     1     version = 0x01
//   1     1     flags（bit0 = 不绑定机器码，bit1 = 永久有效）
//   2     8     机器码（12 个 Base32 字符打包成 60 bit，大端）
//   10    4     serial
//   14    4     issued_at
//   18    4     expires_at（0 表示永久）
//   22    64    Ed25519 签名（覆盖 0..21）

import { sign } from "./ed25519.mjs";

export const OFFLINE_PREFIX = "KAYO";
export const OFFLINE_VERSION = 1;
export const FLAG_ANY_MACHINE = 1;
export const FLAG_PERMANENT = 2;

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LOOKUP = (() => {
  const map = new Map();
  for (let i = 0; i < ALPHABET.length; i++) map.set(ALPHABET[i], i);
  return map;
})();

export function encodeBase32(bytes) {
  let value = 0n;
  let bits = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[Number((value >> BigInt(bits)) & 31n)];
    }
  }
  if (bits > 0) out += ALPHABET[Number((value << BigInt(5 - bits)) & 31n)];
  return out;
}

export function decodeBase32(text) {
  const flat = String(text || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  let value = 0n;
  let bits = 0;
  const out = [];
  for (const ch of flat) {
    const index = LOOKUP.get(ch);
    if (index === undefined) return null;
    value = (value << 5n) | BigInt(index);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push(Number((value >> BigInt(bits)) & 0xffn));
    }
  }
  return Uint8Array.from(out);
}

export function packMachine(machineCode) {
  let chars = String(machineCode || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (chars.startsWith("NAS")) chars = chars.slice(3);
  if (chars.length !== 12) throw new Error("机器码应形如 NAS-XXXX-XXXX-XXXX");
  let value = 0n;
  for (const ch of chars) {
    const index = LOOKUP.get(ch);
    if (index === undefined) throw new Error("机器码含非法字符");
    value = (value << 5n) | BigInt(index);
  }
  const bytes = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

export function unpackMachine(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let chars = "";
  for (let i = 11; i >= 0; i--) chars += ALPHABET[Number((value >> BigInt(i * 5)) & 31n)];
  return "NAS-" + chars.slice(0, 4) + "-" + chars.slice(4, 8) + "-" + chars.slice(8, 12);
}

function group(text, size = 5) {
  const parts = [];
  for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
  return parts.join("-");
}

export function readUInt32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

export function writeUInt32(value) {
  const v = value >>> 0;
  return Uint8Array.from([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

export function buildPayload({ flags = 0, machine = "", serial = 0, issuedAt = 0, expiresAt = 0 }) {
  const machineBytes = flags & FLAG_ANY_MACHINE ? new Uint8Array(8) : packMachine(machine);
  return Uint8Array.from([
    OFFLINE_VERSION,
    flags & 0xff,
    ...machineBytes,
    ...writeUInt32(serial),
    ...writeUInt32(issuedAt),
    ...writeUInt32(expiresAt),
  ]);
}

/**
 * 生成一张离线授权码。
 * @param {Uint8Array} seed 32 字节私钥种子
 * @param {object} fields {machine | flags, serial, issuedAt, expiresAt}
 */
export async function issueOfflineLicense(seed, fields) {
  const payload = buildPayload(fields);
  const signature = await sign(seed, payload);
  const bytes = Uint8Array.from([...payload, ...signature]);
  return OFFLINE_PREFIX + "-" + group(encodeBase32(bytes));
}

export function decodeOfflineLicense(text) {
  const flat = String(text || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (!flat.startsWith(OFFLINE_PREFIX)) return null;
  const bytes = decodeBase32(flat.slice(OFFLINE_PREFIX.length));
  if (!bytes || bytes.length !== 86) return null;
  const payload = bytes.slice(0, 22);
  const flags = payload[1];
  return {
    version: payload[0],
    flags,
    machine: flags & FLAG_ANY_MACHINE ? "" : unpackMachine(payload.slice(2, 10)),
    serial: readUInt32(payload, 10),
    issued_at: readUInt32(payload, 14),
    expires_at: readUInt32(payload, 18),
    payload,
    signature: bytes.slice(22),
  };
}
