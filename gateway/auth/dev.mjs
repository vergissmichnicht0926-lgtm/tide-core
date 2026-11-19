// M2a 联调用的临时鉴权。樱的 auth/index.mjs 落地后会被替换。
export async function authenticate(_req) {
  const userId = String(process.env.TIDE_DEV_USER_ID || '').trim();
  if (userId) return { userId };
  const error = new Error('unauthorized');
  error.status = 401;
  error.code = 'unauthorized';
  throw error;
}
