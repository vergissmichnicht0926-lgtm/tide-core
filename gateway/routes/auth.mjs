// /auth/* 路由 —— 只做「取字段 / 调 service / 拼响应」。
//
// handler 的形状：({ body, params, headers }) => Promise<{status, body}>
// 出错抛 ApiError，由 server.mjs 统一转成 { ok:false, error:{code,message} }。
// 认证不依赖外部中间件——`/auth/devices` 自己从 Authorization 头取 token 校验，
// 这样接进 server 时不用关心别的路由怎么挂。

import { ApiError, unauthorized } from '../auth/errors.mjs';

function bearer(headers) {
  const raw = headers?.authorization ?? headers?.Authorization ?? '';
  if (typeof raw !== 'string') return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * `/auth/refresh` 与 `/auth/logout` 的 refresh token 字段两种写法都认。
 *
 * 病因：请求体里写 `refreshToken` 才是唯一被接受的键，但客户端（Android 那边）发的是
 * `refresh_token`，于是续期恒定 400 —— App 认不出「凭证写错了」和「真的过期了」，
 * 一律显示「登录已失效」。接口里其他字段都是 snake_case（`client_msg_id`、`through_seq`），
 * 这里两种都收，别让字段名再杀死一次登录。
 */
function readRefreshToken(body) {
  // camel 优先；但 `??` 只对 null/undefined 回退，camel 是数字/空串时不该把
  // 后面合法的 snake 挡掉。按“第一个非空字符串”取。
  for (const value of [body?.refreshToken, body?.refresh_token]) {
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

export function createAuthRoutes({ service }) {
  if (!service) throw new Error('createAuthRoutes 需要 service');

  const requireUser = (ctx) => {
    const token = bearer(ctx.headers);
    if (!token) throw unauthorized('token-missing', '缺少 Authorization: Bearer <access token>');
    return service.authenticate(token);
  };

  return [
    {
      method: 'POST',
      path: '/auth/login',
      public: true,
      async handle({ body, headers }) {
        const ip =
          headers?.['x-forwarded-for']?.split(',')[0]?.trim() || headers?.['x-real-ip'] || null;
        const result = await service.login({
          username: body?.username,
          password: body?.password,
          deviceName: body?.deviceName ?? body?.device_name,
          devicePublicKey: body?.devicePublicKey ?? body?.device_public_key,
          keyFingerprint: body?.keyFingerprint ?? body?.key_fingerprint,
          challengeId: body?.challengeId ?? body?.challenge_id,
          signature: body?.signature,
          resetCode: body?.resetCode ?? body?.reset_code,
          ip,
        });
        return {
          status: result.approvalRequired ? 202 : 200,
          body: { ok: true, ...result },
        };
      },
    },

    {
      method: 'POST',
      path: '/auth/device/challenge',
      public: true,
      async handle({ body }) {
        const result = service.issueDeviceChallenge({
          username: body?.username,
          keyFingerprint: body?.keyFingerprint ?? body?.key_fingerprint,
          purpose: body?.purpose || 'login',
        });
        return { status: 200, body: { ok: true, ...result } };
      },
    },

    {
      method: 'POST',
      path: '/auth/register',
      public: true,
      async handle({ body, headers, ctx }) {
        const ip =
          headers?.['x-forwarded-for']?.split(',')[0]?.trim() || headers?.['x-real-ip'] || null;
        const result = await service.registerWithInvite({
          code: body?.code,
          username: body?.username,
          password: body?.password,
          deviceName: body?.deviceName ?? body?.device_name,
          devicePublicKey: body?.devicePublicKey ?? body?.device_public_key,
          keyFingerprint: body?.keyFingerprint ?? body?.key_fingerprint,
          challengeId: body?.challengeId ?? body?.challenge_id,
          signature: body?.signature,
          ip,
        });
        // 邀请码是 bot 邀请时，顺手给 guest 建一条 direct conversation。
        let conversationId = null;
        if (typeof ctx?.createDirectConversation === 'function') {
          try {
            conversationId = await ctx.createDirectConversation({
              userId: result.userId,
              title: '汐语',
            });
          } catch (error) {
            // 账号已建好；会话创建失败时让 guest 走申请/重试，不要把注册整体回滚成 500。
            ctx.logger?.warn?.(`[auth] guest direct 创建失败: ${error?.message ?? error}`);
          }
        }
        return { status: 201, body: { ok: true, ...result, conversationId } };
      },
    },

    {
      method: 'POST',
      path: '/auth/refresh',
      public: true,
      async handle({ body }) {
        const result = service.refresh({ refreshToken: readRefreshToken(body) });
        return { status: 200, body: { ok: true, ...result } };
      },
    },

    {
      method: 'POST',
      path: '/auth/logout',
      public: true,
      async handle({ body }) {
        const result = service.logout({ refreshToken: readRefreshToken(body) });
        return { status: 200, body: result };
      },
    },

    {
      method: 'GET',
      path: '/auth/devices',
      async handle(ctx) {
        const { userId } = requireUser(ctx);
        return { status: 200, body: { ok: true, ...service.listDevices({ userId }) } };
      },
    },

    {
      method: 'POST',
      path: '/auth/devices/:id/revoke',
      async handle(ctx) {
        const { userId } = requireUser(ctx);
        const deviceId = ctx.params?.id;
        if (!deviceId) throw new ApiError(400, 'bad-request', '缺少设备 id');
        const result = service.revokeDevice({ userId, deviceId });
        return { status: 200, body: result };
      },
    },

    {
      method: 'POST',
      path: '/auth/device/enroll-existing',
      async handle(ctx) {
        const who = requireUser(ctx);
        const result = await service.enrollExistingDevice({
          userId: who.userId,
          deviceId: who.deviceId,
          username: ctx.body?.username ?? who.username,
          password: ctx.body?.password,
          devicePublicKey: ctx.body?.devicePublicKey ?? ctx.body?.device_public_key,
          keyFingerprint: ctx.body?.keyFingerprint ?? ctx.body?.key_fingerprint,
          challengeId: ctx.body?.challengeId ?? ctx.body?.challenge_id,
          signature: ctx.body?.signature,
          deviceName: ctx.body?.deviceName ?? ctx.body?.device_name,
        });
        return { status: 200, body: { ok: true, ...result } };
      },
    },

    {
      method: 'GET',
      path: '/auth/device-approvals',
      async handle(ctx) {
        const who = requireUser(ctx);
        return { status: 200, body: { ok: true, ...service.listDeviceApprovals({ userId: who.userId }) } };
      },
    },

    {
      method: 'GET',
      path: '/auth/device-approvals/:id/status',
      public: true,
      async handle(ctx) {
        const result = service.deviceApprovalStatus({
          approvalId: ctx.params?.id,
          approvalToken: ctx.url?.searchParams?.get('token'),
        });
        return { status: 200, body: { ok: true, ...result } };
      },
    },

    {
      method: 'POST',
      path: '/auth/device-approvals/:id/approve',
      async handle(ctx) {
        const who = requireUser(ctx);
        return {
          status: 200,
          body: {
            ok: true,
            ...service.decideDeviceApproval({
              userId: who.userId,
              deviceId: who.deviceId,
              approvalId: ctx.params?.id,
              approve: true,
              verificationCode: ctx.body?.verificationCode ?? ctx.body?.verification_code,
            }),
          },
        };
      },
    },

    {
      method: 'POST',
      path: '/auth/device-approvals/:id/reject',
      async handle(ctx) {
        const who = requireUser(ctx);
        return {
          status: 200,
          body: {
            ok: true,
            ...service.decideDeviceApproval({
              userId: who.userId,
              deviceId: who.deviceId,
              approvalId: ctx.params?.id,
              approve: false,
            }),
          },
        };
      },
    },

    {
      method: 'POST',
      path: '/auth/users/:id/reset-devices',
      async handle(ctx) {
        const who = requireUser(ctx);
        if (who.role !== 'admin') throw new ApiError(403, 'forbidden', '只有管理员能重置设备信任');
        return {
          status: 200,
          body: {
            ok: true,
            ...service.resetDeviceTrust({
              userId: ctx.params?.id,
              actorUserId: who.userId,
            }),
          },
        };
      },
    },

    {
      // 看自己是谁 —— App 启动时确认 access token 还有效
      method: 'GET',
      path: '/auth/me',
      async handle(ctx) {
        const who = requireUser(ctx);
        return {
          status: 200,
          body: {
            ok: true,
            userId: who.userId,
            deviceId: who.deviceId,
            username: who.username,
            role: who.role,
            displayName: who.displayName,
            capabilities: who.capabilities,
          },
        };
      },
    },

    {
      // 改自己的昵称/头像：头像用 data URI，大小由客户端先压到 256px。
      method: 'PATCH',
      path: '/auth/me',
      async handle(ctx) {
        const who = requireUser(ctx);
        return {
          status: 200,
          body: {
            ok: true,
            user: service.updateProfile({
              userId: who.userId,
              displayName: ctx.body?.display_name ?? ctx.body?.displayName,
              avatar: ctx.body?.avatar,
            }),
          },
        };
      },
    },
  ];
}
