// 统一的错误形状 —— 与 gateway-contract.md 里的错误码表对齐。
// 业务层抛 ApiError，由 server.mjs 转成 { ok: false, error: { code, message } }。

export class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (message, extra) => new ApiError(400, 'bad-request', message, extra);
export const unauthorized = (code = 'token-invalid', message = '凭据无效') =>
  new ApiError(401, code, message);
export const forbidden = (code = 'forbidden', message = '无权执行') =>
  new ApiError(403, code, message);
export const notFound = (code = 'not-found', message = '不存在') =>
  new ApiError(404, code, message);
export const tooMany = (message, retryAfterMs) =>
  new ApiError(429, 'too-many-requests', message, { retryAfterMs });
