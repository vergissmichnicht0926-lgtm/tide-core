/** `chat_read_attachment` 的纯格式化层，单独放出来便于测试。 */

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

export function formatAttachmentContent(payload, attachmentId) {
  const name = payload?.name || attachmentId || '附件';
  const size = formatBytes(payload?.size);
  if (typeof payload?.text === 'string') {
    const offset = Number(payload.offset ?? 0);
    const more = payload.truncated
      ? `\n……还有更多（下次传 offset=${offset + payload.text.length}）`
      : '';
    return `${name}\n---\n${payload.text}${more}`;
  }
  const mime = String(payload?.mimeType || '未知类型');
  if (/^image\//i.test(mime)) {
    const dims = payload?.width && payload?.height
      ? ` · ${payload.width}x${payload.height}`
      : '';
    return `[图片 ${name}${dims}${size ? ` · ${size}` : ''}]\n我暂时看不到图片内容。`;
  }
  return `[文件 ${name} · ${mime}${size ? ` · ${size}` : ''}]\n这类文件我读不了内容。需要的话请把关键内容贴成文字。`;
}
