export function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

export async function readJson(req, limit = 1_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      const error = new Error('request body too large');
      error.status = 413;
      error.code = 'payload-too-large';
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('request body is not valid JSON');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
}

export async function readBuffer(req, limit = 1_000_000) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      const error = new Error('request body too large');
      error.status = 413;
      error.code = 'payload-too-large';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * 最小 multipart/form-data 解析：只取第一个带 filename 的文件 part。
 * 其他字段（例如 App 顺手带的 title）忽略。整体大小由 readBuffer 先限住。
 */
export function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!match) {
    const error = new Error('multipart 缺少 boundary');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  const boundary = `--${match[1] || match[2]}`;
  const boundaryBuf = Buffer.from(boundary);
  let cursor = buffer.indexOf(boundaryBuf);
  if (cursor < 0) {
    const error = new Error('multipart boundary 不匹配');
    error.status = 400;
    error.code = 'bad-request';
    throw error;
  }
  cursor += boundaryBuf.length;

  while (cursor < buffer.length) {
    if (buffer.slice(cursor, cursor + 2).toString() === '--') break;
    if (buffer.slice(cursor, cursor + 2).toString() === '\r\n') cursor += 2;

    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd < 0) {
      const error = new Error('multipart 头部不完整');
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
    const headers = buffer.slice(cursor, headerEnd).toString('utf8');
    const bodyStart = headerEnd + 4;
    const next = buffer.indexOf(Buffer.from(`\r\n${boundary}`), bodyStart);
    if (next < 0) {
      const error = new Error('multipart 结尾不完整');
      error.status = 400;
      error.code = 'bad-request';
      throw error;
    }
    const data = buffer.slice(bodyStart, next);
    const disposition = /content-disposition:([^\r\n]*)/i.exec(headers)?.[1] ?? '';
    const filename = /filename="([^"]*)"/i.exec(disposition)?.[1]
      ?? /filename=([^;]+)/i.exec(disposition)?.[1]?.trim()
      ?? null;
    const partType = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim()
      ?? 'application/octet-stream';
    if (filename !== null) {
      return { filename, contentType: partType, data };
    }
    // next 指向 `\r\n--boundary`；跳过 `\r\n` 和整段 boundary，落到下一个 part 的
    // `\r\n`（或终止 boundary 的 `--`）上。只 +2 会把 boundary 开头的 `--`
    // 误认成结束标记，导致“文件字段前面还有普通字段”时直接报没有文件。
    cursor = next + 2 + boundaryBuf.length;
  }

  const error = new Error('multipart 里没有文件');
  error.status = 400;
  error.code = 'bad-request';
  throw error;
}

export function intParam(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) return fallback;
  return n;
}
