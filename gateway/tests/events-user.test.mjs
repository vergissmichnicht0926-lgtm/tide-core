import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus } from '../events.mjs';

const silent = { log() {}, warn() {}, error() {} };

test('用户级订阅按成员展开，conversation 订阅兼容，信封字段完整', () => {
  let members = ['u1', 'u2'];
  const seen = { u1: [], u2: [], conversation: [] };
  const bus = createEventBus({
    logger: silent,
    lookupConversation: () => ({ epoch: 2, userIds: members }),
  });
  const off1 = bus.subscribeUser('u1', (event) => seen.u1.push(event));
  const off2 = bus.subscribeUser('u2', (event) => seen.u2.push(event));
  bus.subscribe('c1', (event) => seen.conversation.push(event));

  const delivered = bus.publish('c1', {
    type: 'assistant_message',
    seq: 7,
    message: { id: 'm7', seq: 7 },
  });
  assert.equal(delivered, 3);
  assert.equal(seen.u1.length, 1);
  assert.equal(seen.u2.length, 1);
  assert.equal(seen.conversation.length, 1);

  const event = seen.u1[0];
  assert.equal(event.v, 1);
  assert.equal(event.type, 'assistant_message');
  assert.equal(event.conversationId, 'c1');
  assert.equal(event.epoch, 2);
  assert.equal(event.seq, 7);
  assert.equal(event.messageId, 'm7');
  assert.equal(event.createdAt, event.at);
  assert.ok(event.createdAt);

  members = ['u2'];
  bus.publish('c1', { type: 'user_message', seq: 8, message: { id: 'm8', seq: 8 } });
  assert.equal(seen.u1.length, 1, '移除成员后 u1 不再收到');
  assert.equal(seen.u2.length, 2);

  off1();
  off2();
});

test('publishUser 只发给目标用户，read 事件带 lastReadSeq', () => {
  const seen = { u1: [], u2: [] };
  const bus = createEventBus({ logger: silent });
  bus.subscribeUser('u1', (event) => seen.u1.push(event));
  bus.subscribeUser('u2', (event) => seen.u2.push(event));

  const delivered = bus.publishUser('u1', {
    type: 'conversation.read',
    conversationId: 'c1',
    epoch: 2,
    lastReadSeq: 9,
  });
  assert.equal(delivered, 1);
  assert.equal(seen.u1.length, 1);
  assert.equal(seen.u2.length, 0);
  assert.equal(seen.u1[0].conversationId, 'c1');
  assert.equal(seen.u1[0].epoch, 2);
  assert.equal(seen.u1[0].lastReadSeq, 9);
});

test('成员查询失败时 conversation listener 仍收到；close 后 publish 为 0', () => {
  const seen = { conversation: [], user: [] };
  const bus = createEventBus({
    logger: silent,
    lookupConversation() {
      throw new Error('db down');
    },
  });
  bus.subscribe('c1', (event) => seen.conversation.push(event));
  bus.subscribeUser('u1', (event) => seen.user.push(event));

  const delivered = bus.publish('c1', { type: 'turn_start', message: null });
  assert.equal(delivered, 1);
  assert.equal(seen.conversation.length, 1);
  assert.equal(seen.user.length, 0);
  assert.equal(seen.conversation[0].epoch, 1);

  bus.close();
  assert.equal(bus.publish('c1', { type: 'turn_end' }), 0);
  assert.equal(bus.publishUser('u1', { type: 'conversation.read' }), 0);
});
