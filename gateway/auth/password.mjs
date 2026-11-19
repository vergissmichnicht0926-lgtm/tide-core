// 密码哈希 —— node:crypto 的 scrypt，零原生构建。
//
// 存储格式：scrypt$N$r$p$<salt-b64url>$<hash-b64url>
// 前缀写死算法与参数，将来换 argon2 时可以按前缀分流，老记录照样能验。

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 };
const ALGO = 'scrypt';

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('password 必须是非空字符串');
  }
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    ALGO,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6) return false;

  const [algo, nStr, rStr, pStr, saltB64, hashB64] = parts;
  if (algo !== ALGO) return false;

  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(saltB64, 'base64url');
    expected = Buffer.from(hashB64, 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual;
  try {
    actual = await scrypt(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * 1024 * 1024,
    });
  } catch {
    // 参数离谱（比如 N 不是 2 的幂）时 scrypt 会抛，按验证失败处理
    return false;
  }

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
