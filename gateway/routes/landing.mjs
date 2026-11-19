/**
 * 公开邀请落地页：GET /j/<code>
 *
 * 微信/QQ 里 tide:// 自定义 scheme 不可点，所以分享出去的是这个 https 链接；
 * 页面用 intent:// 唤起 App（Chrome 支持），失败时回落到安装包下载。
 */
import { nowMs } from '../db/index.mjs';

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function page({ title, body, status = 200 }) {
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#F6EFE2; color:#2B2B2B;
         font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; }
  main { width:min(360px,82vw); text-align:center; }
  h1 { font-size:20px; font-weight:600; margin:0 0 8px; }
  p { font-size:14px; line-height:1.7; color:#8A8074; margin:0 0 22px; }
  a.btn { display:block; padding:14px; border-radius:26px; background:#5B8C7E; color:#fff;
          text-decoration:none; font-size:16px; }
  a.ghost { display:block; margin-top:12px; padding:12px; border-radius:26px;
            border:1px solid #EFE6DC; color:#2B2B2B; text-decoration:none; font-size:14px; }
  code { display:inline-block; margin-top:18px; font-size:13px; color:#8A8074;
         letter-spacing:.12em; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
  return { status, html };
}

function buildJoinUrl(publicBaseUrl, code, kind, groupId) {
  const url = new URL('tide://join');
  url.searchParams.set('server', publicBaseUrl);
  url.searchParams.set('code', code);
  url.searchParams.set('kind', kind);
  if (groupId) url.searchParams.set('group', groupId);
  return url.toString();
}

export async function handleLanding(req, res, url, ctx) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('method not allowed');
  }
  const code = decodeURIComponent(url.pathname.slice('/j/'.length));
  const publicBaseUrl = ctx.publicBaseUrl || '';
  const invite = code
    ? ctx.dbState.db.prepare('SELECT * FROM invite WHERE code = ?').get(code)
    : null;

  let view;
  if (!invite) {
    view = page({
      title: '邀请码无效',
      status: 404,
      body: '<h1>邀请码无效</h1><p>这条邀请可能已经失效，找发你的人再要一条。</p>',
    });
  } else if (invite.revoked_at) {
    view = page({
      title: '邀请码已撤销',
      status: 410,
      body: '<h1>邀请码已撤销</h1><p>发你的人收回了这条邀请。</p>',
    });
  } else if (Number(invite.expires_at) <= nowMs()) {
    view = page({
      title: '邀请码已过期',
      status: 410,
      body: '<h1>邀请码已过期</h1><p>找发你的人再要一条新的。</p>',
    });
  } else if (Number(invite.used_count) >= Number(invite.max_uses)) {
    view = page({
      title: '邀请码已用完',
      status: 410,
      body: '<h1>邀请码已被用完</h1><p>一条邀请只能用一次，找发你的人再要一条。</p>',
    });
  } else {
    const joinUrl = buildJoinUrl(publicBaseUrl, invite.code, invite.kind, invite.group_id);
    const apkUrl = publicBaseUrl
      ? `${publicBaseUrl.replace(/\/tide$/, '')}/dl/tide-latest.apk`
      : '';
    const intent = `intent://join?${new URL(joinUrl).searchParams.toString()}#Intent;scheme=tide;package=com.whaleeye.tide;S.browser_fallback_url=${encodeURIComponent(
      apkUrl || 'https://example.invalid/',
    )};end`;
    const label = invite.kind === 'group' ? '邀请你加入群聊' : '邀请你使用汐语';
    view = page({
      title: '汐语邀请',
      body: `<h1>${escapeHtml(label)}</h1>
        <p>点下面的按钮打开汐语，会自动填好服务器和邀请码。</p>
        <a class="btn" href="${escapeHtml(intent)}">打开汐语</a>
        <a class="ghost" href="${escapeHtml(apkUrl || intent)}">没装？先下载安装包</a>`,
    });
  }

  res.writeHead(view.status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : view.html);
}
