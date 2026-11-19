/** 0.34：图片尺寸、prompt 图片块、跨会话表情附件与读附件文案。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createGateway } from '../server.mjs';
import { collectImageBlocks, conversationRow } from '../dsh/delivery.mjs';
import { admitImage, imageSize, resetImageCache } from '../dsh/images.mjs';
import { formatAttachmentContent } from '../../mcp/format-attachment.mjs';

const silent = { log() {}, warn() {}, error() {} };
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

function jpegWithSize(width, height) {
  const head = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x00, 0x00, 0x00, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
  head.writeUInt16BE(height, 7);
  head.writeUInt16BE(width, 9);
  return Buffer.concat([head, Buffer.from([0xff, 0xd9])]);
}

function gifWithSize(width, height) {
  const buffer = Buffer.alloc(13);
  buffer.write('GIF89a', 0, 'ascii');
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

async function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-images-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gw.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    startSocial: false,
    startRebuildWorker: false,
    logger: silent,
  });
  const admin = await gateway.authService.createUser({
    username: 'admin',
    password: 'password123',
    role: 'admin',
    displayName: '管理员',
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'password123', device_name: 'test' }),
  }).then((res) => res.json());
  const token = login.accessToken;
  const direct = await gateway.ctx.createDirectConversation({ userId: admin.id, title: '汐语' });
  const directId = typeof direct === 'string' ? direct : direct.id;
  const group = await fetch(`${base}/conversations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: '图片测试群', kind: 'group' }),
  }).then((res) => res.json());
  return { gateway, admin, direct: directId, group, base, token };
}

async function closeServer(gateway) {
  await new Promise((resolve) => gateway.server.close(resolve));
}

async function upload(s, conversationId, bytes, name) {
  const res = await fetch(`${s.base}/conversations/${conversationId}/upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${s.token}`,
      'content-type': 'image/png',
      'x-file-name': name,
    },
    body: bytes,
  });
  assert.equal(res.status, 201);
  return res.json();
}

test('图片尺寸解析覆盖 PNG / JPEG / GIF，未知字节返回 null', () => {
  assert.deepEqual(imageSize(PNG), { width: 1, height: 1 });
  assert.deepEqual(imageSize(jpegWithSize(128, 256)), { width: 128, height: 256 });
  assert.deepEqual(imageSize(gifWithSize(64, 48)), { width: 64, height: 48 });
  assert.equal(imageSize(Buffer.from('not an image')), null);
});

test('admitImage 返回只含 schema 字段的图片块，并拒绝非图片/超限', () => {
  resetImageCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-image-file-'));
  const file = path.join(dir, 'a.png');
  fs.writeFileSync(file, PNG);
  const block = admitImage({ path: file, mediaType: 'image/png', name: 'a.png' });
  assert.equal(block.type, 'image');
  assert.equal(block.mediaType, 'image/png');
  assert.equal(block.width, 1);
  assert.equal(block.height, 1);
  assert.ok(block.data.length > 20);
  assert.throws(
    () => admitImage({ path: file, mediaType: 'application/pdf', name: 'a.pdf' }),
    /不支持/,
  );
  assert.throws(
    () => admitImage({ path: file, mediaType: 'image/png', name: 'a.png', maxBytes: 10 }),
    /超过/,
  );
});

test('chat_read_attachment 文案不再出现 undefined / 裸 base64', () => {
  const text = formatAttachmentContent(
    { name: 'note.txt', newMimeType: 'text/plain', mimeType: 'text/plain', size: 12, text: 'hello', offset: 0, truncated: false },
    'a1',
  );
  assert.match(text, /note\.txt/);
  assert.match(text, /hello/);
  assert.doesNotMatch(text, /undefined|null/);

  const image = formatAttachmentContent(
    { name: 'shot.png', mimeType: 'image/png', size: 1_180_000, width: 1170, height: 2532, data: 'AAAA' },
    'a2',
  );
  assert.match(image, /\[图片 shot\.png · 1170x2532 · 1\.1 MB\]/);
  assert.match(image, /看不到/);
  assert.doesNotMatch(image, /undefined|null|AAAA/);
  assert.ok(image.length < 1000);

  const pdf = formatAttachmentContent(
    { name: 'doc.pdf', mimeType: 'application/pdf', size: 2_097_152, data: 'AAAA' },
    'a3',
  );
  assert.match(pdf, /\[文件 doc\.pdf · application\/pdf · 2\.0 MB\]/);
  assert.match(pdf, /读不了内容/);
  assert.doesNotMatch(pdf, /undefined|null/);
  assert.ok(pdf.length < 1000);
});

test('collectImageBlocks 认识跨会话表情附件，读不到时写 notes', async () => {
  const s = await makeServer();
  try {
    const uploaded = await upload(s, s.direct, PNG, 'sticker.png');
    const created = await fetch(`${s.base}/stickers`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ attachmentId: uploaded.attachment_id, name: '开心' }),
    });
    assert.equal(created.status, 200);

    const db = s.gateway.dbState.db;
    const insert = (id, seq, attachments) => {
      db.prepare(
        `INSERT INTO message (id, conversation_id, role, content_json, created_at, seq, sender_user_id, sender_name)
         VALUES (?, ?, 'user', ?, ?, ?, ?, '管理员')`,
      ).run(
        id,
        s.group.id,
        JSON.stringify({ type: 'text', text: '', attachments }),
        Date.now() + seq,
        seq,
        s.admin.id,
      );
    };
    insert(randomUUID(), 1, [uploaded.attachment_id]);
    db.prepare('UPDATE conversation SET agent_read_seq = 0 WHERE id = ?').run(s.group.id);

    const conversation = conversationRow(s.gateway.ctx, s.group.id);
    const ok = collectImageBlocks(s.gateway.ctx, conversation);
    assert.equal(ok.blocks.length, 1);
    assert.deepEqual(Object.keys(ok.blocks[0]).sort(), ['data', 'mediaType', 'name', 'type']);
    assert.equal(ok.notes.length, 0);

    // 把源文件删掉：这条要降级成 notes，而不是不声不响。
    const row = db.prepare('SELECT local_path FROM attachment WHERE id = ?').get(uploaded.attachment_id);
    fs.unlinkSync(row.local_path);
    const failed = collectImageBlocks(s.gateway.ctx, conversation);
    assert.equal(failed.blocks.length, 0);
    assert.equal(failed.notes.length, 1);
    assert.match(failed.notes[0], /暂时无法查看/);
  } finally {
    await closeServer(s.gateway);
  }
});

test('collectImageBlocks 跳过非图片附件', async () => {
  const s = await makeServer();
  try {
    const res = await fetch(`${s.base}/conversations/${s.group.id}/upload`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${s.token}`,
        'content-type': 'application/pdf',
        'x-file-name': 'doc.pdf',
      },
      body: Buffer.from('%PDF-1.4 test'),
    });
    const pdf = await res.json();
    const db = s.gateway.dbState.db;
    db.prepare(
      `INSERT INTO message (id, conversation_id, role, content_json, created_at, seq, sender_user_id, sender_name)
       VALUES (?, ?, 'user', ?, ?, 1, ?, '管理员')`,
    ).run(
      randomUUID(),
      s.group.id,
      JSON.stringify({ type: 'text', text: '文件', attachments: [pdf.attachment_id] }),
      Date.now(),
      s.admin.id,
    );
    db.prepare('UPDATE conversation SET agent_read_seq = 0 WHERE id = ?').run(s.group.id);
    const result = collectImageBlocks(s.gateway.ctx, conversationRow(s.gateway.ctx, s.group.id));
    assert.equal(result.blocks.length, 0);
    assert.equal(result.notes.length, 0);
  } finally {
    await closeServer(s.gateway);
  }
});
