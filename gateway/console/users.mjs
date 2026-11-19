/** 管理台用户与设备：列表 / 按用户列设备 / 吊销。 */

import { ApiError } from '../auth/errors.mjs';
import { audit, listUsers } from '../routes/admin-data.mjs';
import { closeStreamsForDevice } from '../routes/conversations.mjs';
import { writeConsoleChange } from './http.mjs';

export function getUsers(ctx, url) {
  const result = listUsers(ctx);
  const q = String(url?.searchParams?.get('q') || '').trim().toLowerCase();
  if (!q) return result;
  return {
    ...result,
    users: result.users.filter((user) =>
      String(user.username || '').toLowerCase().includes(q)),
  };
}

export function getDevices(ctx, userId) {
  const user = ctx.dbState.db.prepare(
    'SELECT id, username, display_name, role, disabled_at FROM users WHERE id = ?',
  ).get(userId);
  if (!user) throw new ApiError(404, 'user-not-found', '用户不存在');
  const { devices } = ctx.authService.listDevices({ userId });
  const now = Date.now();
  const liveByDevice = new Map();
  for (const cleanup of ctx.sseConnections ?? []) {
    if (cleanup.userId !== userId || !cleanup.deviceId) continue;
    liveByDevice.set(cleanup.deviceId, (liveByDevice.get(cleanup.deviceId) || 0) + 1);
  }
  const view = devices.map((device) => ({
    ...device,
    trusted: Boolean(device.trustedDeviceId),
    active: !device.revokedAt && Date.parse(device.expiresAt) > now,
    liveConnections: liveByDevice.get(device.id) || 0,
  }));
  // 活跃设备排前面，其余按最近使用/创建时间倒序；抽屉里几十台历史设备时更好找。
  view.sort((a, b) => (
    Number(b.active) - Number(a.active)
    || Date.parse(b.lastSeenAt || b.createdAt) - Date.parse(a.lastSeenAt || a.createdAt)
  ));
  return {
    user: {
      userId: user.id,
      username: user.username,
      displayName: user.display_name || user.username,
      role: user.role,
      disabled: Boolean(user.disabled_at),
    },
    devices: view,
  };
}

export function revokeDevice(ctx, session, userId, deviceId) {
  const device = ctx.dbState.db.prepare(
    'SELECT id, user_id, trusted_device_id FROM devices WHERE id = ?',
  ).get(deviceId);
  if (!device || device.user_id !== userId) {
    throw new ApiError(404, 'not-found', '设备不存在');
  }
  const groupIds = device.trusted_device_id
    ? ctx.dbState.db.prepare(
      'SELECT id FROM devices WHERE user_id = ? AND trusted_device_id = ?',
    ).all(userId, device.trusted_device_id).map((row) => row.id)
    : [deviceId];

  const result = ctx.authService.revokeDevice({ userId, deviceId });
  let closedStreams = 0;
  for (const id of groupIds) {
    closedStreams += closeStreamsForDevice(ctx, userId, id);
  }
  audit(ctx, session.user.userId, 'device.revoke', deviceId, { userId, devices: groupIds });
  writeConsoleChange(ctx, 'device.revoke', deviceId, {
    userId,
    revokedDevices: groupIds.length,
    closedStreams,
  });
  return {
    ok: true,
    revokedDeviceId: deviceId,
    revokedDeviceIds: groupIds,
    closedStreams,
    alreadyRevoked: Boolean(result.alreadyRevoked),
  };
}
