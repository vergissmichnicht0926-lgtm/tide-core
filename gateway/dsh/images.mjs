/**
 * 图片进 prompt 的准备层。
 *
 * DSH `session/prompt` 的 wire 格式是内联 `{ type:'image', mediaType, data(base64), name? }`，
 * 由 DSH 自己归一化并落成 `sha256:` 附件引用（见 dsh-api-session-controller 的
 * PromptContentPart 定义）。聊天记录里看到的 attachment 引用是落库后的形态，不是发送格式。
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

export const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const CACHE_MAX_BYTES = 48 * 1024 * 1024;
const cache = new Map();
let cacheBytes = 0;

export function resetImageCache() {
  cache.clear();
  cacheBytes = 0;
}

function cacheKey(path, stat) {
  return `${path}|${stat.size}|${Math.trunc(stat.mtimeMs)}`;
}

function remember(key, block) {
  const cost = block.data.length;
  if (cost > CACHE_MAX_BYTES / 2) return;
  const previous = cache.get(key);
  if (previous) {
    cacheBytes -= previous.data.length;
    cache.delete(key);
  }
  cache.set(key, block);
  cacheBytes += cost;
  while (cacheBytes > CACHE_MAX_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const dropped = cache.get(oldest);
    cache.delete(oldest);
    cacheBytes -= dropped?.data.length ?? 0;
  }
}

/** PNG / JPEG / GIF / WebP 的原始像素尺寸；读不出返回 null。 */
export function imageSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10) return null;

  // PNG: signature + IHDR
  if (buffer.length >= 24
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  // GIF: logical screen descriptor
  if (buffer.length >= 10
    && buffer.toString('ascii', 0, 3) === 'GIF') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }

  // JPEG: scan SOF segments
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > buffer.length) return null;
      const isSof = (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf);
      if (isSof) {
        return {
          width: buffer.readUInt16BE(offset + 7),
          height: buffer.readUInt16BE(offset + 5),
        };
      }
      offset += 2 + length;
    }
    return null;
  }

  // WebP: VP8X / VP8L / VP8
  if (buffer.length >= 30
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }
    if (chunk === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    if (chunk === 'VP8 ' && buffer.length >= 30) {
      if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
  }

  return null;
}

/**
 * 读取一张本地图片，返回可直接塞进 prompt content 的 image 块。
 * 同路径同 mtime 的结果会缓存在进程内，避免重复读盘和 base64。
 */
export function admitImage({ path, mediaType, name, maxBytes = 12 * 1024 * 1024 }) {
  if (!IMAGE_TYPES.has(mediaType)) {
    throw new Error(`不支持的图片类型: ${mediaType}`);
  }
  const stat = fs.statSync(path);
  if (stat.size > maxBytes) {
    throw new Error(`图片超过 ${Math.floor(maxBytes / 1024 / 1024)} MB`);
  }
  const key = cacheKey(path, stat);
  const cached = cache.get(key);
  if (cached) return cached;

  const started = Date.now();
  const buffer = fs.readFileSync(path);
  const size = imageSize(buffer);
  if (!size || !size.width || !size.height) {
    throw new Error('图片头解析失败');
  }
  const block = {
    type: 'image',
    mediaType,
    data: buffer.toString('base64'),
    name: name || undefined,
    width: size.width,
    height: size.height,
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    prepareMs: Date.now() - started,
  };
  remember(key, block);
  return block;
}
