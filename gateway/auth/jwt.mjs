// HS256 JWT —— 自己实现，零依赖。
//
// 为什么不用 jose：gateway 是独立项目，从 lab 的 node_modules 里借包会把部署
// 依赖绑到另一个工程上；HS256 就三段 base64url + 一个 HMAC，四十行写完更好审。
// 需要 RS256 / JWKS 时再换。

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const HEADER = { alg: 'HS256', typ: 'JWT' };

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(data, secret) {
  return b64url(createHmac('sha256', secret).update(data).digest());
}

export function newSecret(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

/**
 * @param {object} payload  业务字段（sub / dev / ...）
 * @param {{secret: string, expiresInSec?: number, now?: () => number}} opts
 */
export function signJwt(payload, { secret, expiresInSec = 900, now = Date.now } = {}) {
  if (!secret) throw new Error('签 JWT 需要 secret');

  const iat = Math.floor(now() / 1000);
  const body = {
    ...payload,
    iat,
    exp: expiresInSec ? iat + expiresInSec : undefined,
  };
  if (body.exp === undefined) delete body.exp;

  const head = b64url(JSON.stringify(HEADER));
  const data = b64url(JSON.stringify(body));
  const input = `${head}.${data}`;
  return `${input}.${sign(input, secret)}`;
}

/**
 * 校验签名与 exp。失败抛带 code 的 Error，成功返回 payload。
 * @returns {{ok: true, payload: object} | never}
 */
export function verifyJwt(token, { secret, now = Date.now } = {}) {
  if (!secret) throw new Error('验 JWT 需要 secret');
  if (typeof token !== 'string') throw jwtError('malformed', 'token 不是字符串');

  const parts = token.split('.');
  if (parts.length !== 3) throw jwtError('malformed', 'JWT 必须有且只有三段');
  const [head, data, sig] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    throw jwtError('malformed', 'JWT 内容不是合法 JSON');
  }

  if (header?.alg !== 'HS256') throw jwtError('unsupported-alg', `不支持的 alg: ${header?.alg}`);

  const expected = sign(`${head}.${data}`, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw jwtError('bad-signature', 'JWT 签名不匹配');
  }

  if (typeof payload.exp === 'number' && Math.floor(now() / 1000) >= payload.exp) {
    throw jwtError('expired', 'JWT 已过期');
  }

  return { ok: true, payload };
}

function jwtError(code, message) {
  const err = new Error(message);
  err.name = 'JwtError';
  err.code = code;
  return err;
}
