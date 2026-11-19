/** 0.12：昵称/头像上云、单成员接口与头像可见性。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGateway } from '../server.mjs';

const silent = { log() {}, warn() {}, error() {} };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function makeServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tide-profile-'));
  const gateway = await createGateway({
    agentSecret: 'test-secret',
    dbPath: path.join(dir, 'gw.db'),
    workspaceRoot: path.join(dir, 'workspaces'),
    startSocial: false,
    startRebuildWorker: false,
    logger: silent,
  });
  const owner = await gateway.authService.createUser({
    username: 'owner', password: 'password123', role: 'admin', displayName: '群主',
  });
  const guest = await gateway.authService.createUser({
    username: 'guest', password: 'password123', role: 'guest', displayName: '旅客',
  });
  const outsider = await gateway.authService.createUser({
    username: 'outsider', password: 'password123', role: 'guest', displayName: '外人',
  });
  await new Promise((resolve) => gateway.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${gateway.server.address().port}`;
  const login = async (username) => {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'password123', device_name: 'test' }),
    });
    return res.json();
  };
  const sessions = {
    owner: await login('owner'),
    guest: await login('guest'),
    outsider: await login('outsider'),
  };
  const api = (p, { token, ...init } = {}) =>
    fetch(`${base}${p}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
  const group = await (await api('/conversations', {
    token: sessions.owner.accessToken,
    method: 'POST',
    body: JSON.stringify({ title: '资料测试群', kind: 'group' }),
  })).json();
  await api(`/conversations/${group.id}/members`, {
    token: sessions.owner.accessToken,
    method: 'POST',
    body: JSON.stringify({ user_id: guest.id }),
  });
  return {
    gateway, base, api, sessions, groupId: group.id, owner, guest, outsider,
    async close() {
      gateway.closeSse();
      await new Promise((resolve) => gateway.server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('昵称上云并同步到群成员显示名', async () => {
  const s = await makeServer();
  try {
    const updated = await s.api('/auth/me', {
      token: s.sessions.owner.accessToken,
      method: 'PATCH',
      body: JSON.stringify({ display_name: '新群主' }),
    });
    assert.equal(updated.status, 200);
    const body = await updated.json();
    assert.equal(body.user.displayName, '新群主');

    const members = await (await s.api(`/conversations/${s.groupId}/members`, {
      token: s.sessions.guest.accessToken,
    })).json();
    const ownerRow = members.members.find((m) => m.user_id === s.owner.id);
    assert.equal(ownerRow.display_name, '新群主');

    const me = await (await s.api('/auth/me', {
      token: s.sessions.owner.accessToken,
    })).json();
    assert.equal(me.displayName, '新群主');

    const empty = await s.api('/auth/me', {
      token: s.sessions.owner.accessToken,
      method: 'PATCH',
      body: JSON.stringify({ display_name: '  ' }),
    });
    assert.equal(empty.status, 400);
    const tooLong = await s.api('/auth/me', {
      token: s.sessions.owner.accessToken,
      method: 'PATCH',
      body: JSON.stringify({ display_name: '字'.repeat(31) }),
    });
    assert.equal(tooLong.status, 400);
  } finally {
    await s.close();
  }
});

test('头像上云：同群可见，非成员 404，清空后 404', async () => {
  const s = await makeServer();
  try {
    const saved = await s.api('/auth/me', {
      token: s.sessions.owner.accessToken,
      method: 'PATCH',
      body: JSON.stringify({ avatar: PNG }),
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.user.hasAvatar, true);
    assert.ok(savedBody.user.avatarVersion);

    const members = await (await s.api(`/conversations/${s.groupId}/members`, {
      token: s.sessions.guest.accessToken,
    })).json();
    const ownerRow = members.members.find((m) => m.user_id === s.owner.id);
    assert.equal(ownerRow.has_avatar, true);
    assert.equal(ownerRow.avatar_version, savedBody.user.avatarVersion);

    const sharedRes = await s.api(`/users/${s.owner.id}/avatar`, {
      token: s.sessions.guest.accessToken,
    });
    assert.equal(sharedRes.status, 200);
    assert.equal(sharedRes.headers.get('content-type'), 'image/png');
    assert.ok((await sharedRes.arrayBuffer()).byteLength > 0);

    const outsiderRes = await s.api(`/users/${s.owner.id}/avatar`, {
      token: s.sessions.outsider.accessToken,
    });
    assert.equal(outsiderRes.status, 404);

    const anonymous = await s.api(`/users/${s.owner.id}/avatar`);
    assert.equal(anonymous.status, 401);

    const bad = await s.api('/auth/me', {
      token: s.sessions.owner.accessToken,
      method: 'PATCH',
      body: JSON.stringify({ avatar: 'not-a-data-uri' }),
    });
    assert.equal(bad.status, 400);

    const cleared = await (await s.api('/auth/me', {
      token: s.sessions.owner.accessToken,
      method: 'PATCH',
      body: JSON.stringify({ avatar: '' }),
    })).json();
    assert.equal(cleared.user.hasAvatar, false);
    const gone = await s.api(`/users/${s.owner.id}/avatar`, {
      token: s.sessions.guest.accessToken,
    });
    assert.equal(gone.status, 404);
  } finally {
    await s.close();
  }
});

test('单成员接口只返回一个人，非成员看不到', async () => {
  const s = await makeServer();
  try {
    const one = await (await s.api(
      `/conversations/${s.groupId}/members/${s.guest.id}`,
      { token: s.sessions.owner.accessToken },
    )).json();
    assert.equal(one.member.user_id, s.guest.id);
    assert.equal(one.member.username, 'guest');
    assert.equal(one.member.role, 'member');

    const denied = await s.api(
      `/conversations/${s.groupId}/members/${s.guest.id}`,
      { token: s.sessions.outsider.accessToken },
    );
    assert.equal(denied.status, 404);

    const missing = await s.api(
      `/conversations/${s.groupId}/members/usr_missing`,
      { token: s.sessions.owner.accessToken },
    );
    assert.equal(missing.status, 404);
  } finally {
    await s.close();
  }
});
