// 纯 JS（BigInt）Ed25519 签发，RFC 8032。
// 不依赖平台是否支持 WebCrypto 的 Ed25519 算法，Cloudflare Workers 与 Node 18+ 通用。
// 只用于签发（发卡后台、本地签发工具），面板端验签走 license_ed25519.py。

const q = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

function mod(a, m = q) {
  const r = a % m;
  return r < 0n ? r + m : r;
}

function inv(x) {
  return powmod(mod(x), q - 2n, q);
}

function powmod(base, exp, m) {
  let result = 1n;
  let value = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = result * value % m;
    value = value * value % m;
    e >>= 1n;
  }
  return result;
}

const d = mod(-121665n * inv(121666n));
const sqrtM1 = powmod(2n, (q - 1n) / 4n, q);

function recoverX(y, sign) {
  if (y >= q) return null;
  const xx = mod((y * y - 1n) * inv(d * y * y + 1n));
  let x = powmod(xx, (q + 3n) / 8n, q);
  if (mod(x * x - xx) !== 0n) x = mod(x * sqrtM1);
  if (mod(x * x - xx) !== 0n) return null;
  if (x % 2n !== 0n) x = q - x;
  if (x % 2n !== sign) x = q - x;
  return x >= q ? null : x;
}

function encodePoint(point) {
  const [x, y, z] = point;
  const zi = inv(z);
  const ax = mod(x * zi);
  const ay = mod(y * zi);
  const bytes = new Uint8Array(32);
  let value = ay | ((ax & 1n) << 255n);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function leToBigInt(bytes) {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

function bigToLe(value, length) {
  const bytes = new Uint8Array(length);
  let v = value;
  for (let i = 0; i < length; i++) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return bytes;
}

// 扩展坐标 (X, Y, Z, T)，加法与倍乘统一公式，无需逐次求逆。
function edwards(P, Q) {
  const a = mod((P[1] - P[0]) * (Q[1] - Q[0]));
  const b = mod((P[1] + P[0]) * (Q[1] + Q[0]));
  const c = mod(2n * P[3] * Q[3] % q * d);
  const dd = mod(2n * P[2] * Q[2]);
  const e = b - a;
  const f = dd - c;
  const g = dd + c;
  const h = b + a;
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}

function scalarmult(P, scalar) {
  let e = scalar;
  let result = [0n, 1n, 1n, 0n];
  let base = P;
  while (e > 0n) {
    if (e & 1n) result = edwards(result, base);
    base = edwards(base, base);
    e >>= 1n;
  }
  return result;
}

const by = mod(4n * inv(5n));
const bx = recoverX(by, 0n);
const G = [bx, by, 1n, mod(bx * by)];

async function sha512(data) {
  const buffer = await crypto.subtle.digest("SHA-512", data);
  return new Uint8Array(buffer);
}

function concat(...parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function clampScalar(hash) {
  const bytes = hash.slice(0, 32);
  bytes[0] &= 248;
  bytes[31] &= 127;
  bytes[31] |= 64;
  return leToBigInt(bytes);
}

export function publicKeyFromSeed(seed) {
  if (seed.length !== 32) throw new Error("私钥种子必须是 32 字节");
  return sha512(seed).then((hash) => encodePoint(scalarmult(G, clampScalar(hash))));
}

/**
 * 用 32 字节种子私钥对消息签名，返回 64 字节签名。
 */
export async function sign(seed, message) {
  if (seed.length !== 32) throw new Error("私钥种子必须是 32 字节");
  const hash = await sha512(seed);
  const scalar = clampScalar(hash);
  const publicKey = encodePoint(scalarmult(G, scalar));
  const nonceHash = await sha512(concat(hash.slice(32), message));
  const r = mod(leToBigInt(nonceHash), L);
  const R = encodePoint(scalarmult(G, r));
  const challenge = mod(leToBigInt(await sha512(concat(R, publicKey, message))), L);
  const S = mod(challenge * scalar + r, L);
  return concat(R, bigToLe(S, 32));
}

/**
 * 验签：与面板端 license_ed25519.py 判据一致，用于签发后台自检。
 * 面板运行时不加载本文件（那里用纯 Python 实现），所以这里可以慢一点。
 */
function fromAffine(bytes) {
  if (bytes.length !== 32) return null;
  const value = leToBigInt(bytes);
  const sign = (value >> 255n) & 1n;
  const y = value & ((1n << 255n) - 1n);
  const x = recoverX(y, sign);
  if (x === null) return null;
  return [x, y, 1n, mod(x * y)];
}

export async function verify(publicKey, message, signature) {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const R = fromAffine(signature.slice(0, 32));
  const A = fromAffine(publicKey);
  const S = leToBigInt(signature.slice(32));
  if (!R || !A || S >= L) return false;
  const challenge = mod(leToBigInt(await sha512(concat(signature.slice(0, 32), publicKey, message))), L);
  const left = encodePoint(scalarmult(G, S));
  const right = encodePoint(edwards(R, scalarmult(A, challenge)));
  for (let i = 0; i < 32; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

export { concat, sha512, leToBigInt, bigToLe, mod, L, q };
