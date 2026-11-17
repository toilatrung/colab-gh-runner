// Kiểm thử các endpoint qua HTTP thật (server http của Node + handler), Redis = bộ nhớ trong.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

Object.assign(process.env, {
  HEARTBEAT_SECRET: 'hb-secret', CHECK_SECRET: 'chk-secret', AGENT_TOKEN: 'agent-tok',
  DASHBOARD_PASSWORD: 'pw123', SESSION_SECRET: 'x'.repeat(40),
  TELEGRAM_WEBHOOK_SECRET: 'wh-secret', TELEGRAM_CHAT_ID: '42', // không có bot token → Telegram no-op
});
delete process.env.KV_REST_API_URL;
delete process.env.UPSTASH_REDIS_REST_URL;

const routes = {
  '/api/heartbeat': (await import('../api/heartbeat.js')).default,
  '/api/check': (await import('../api/check.js')).default,
  '/api/login': (await import('../api/login.js')).default,
  '/api/status': (await import('../api/status.js')).default,
  '/api/rerun': (await import('../api/rerun.js')).default,
  '/api/telegram': (await import('../api/telegram.js')).default,
  '/api/agent/next': (await import('../api/agent/next.js')).default,
  '/api/agent/ack': (await import('../api/agent/ack.js')).default,
};

let server, base;
before(async () => {
  server = http.createServer((req, res) => {
    const h = routes[new URL(req.url, 'http://x').pathname];
    return h ? h(req, res) : (res.statusCode = 404, res.end());
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = (path, { method = 'GET', headers = {}, body } = {}) =>
  fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && (typeof body === 'string' ? body : JSON.stringify(body)) });

const HB = { session_id: 's1', event: 'start', runner_state: 'running', cpu: 5 };

test('heartbeat: 401 khi sai/thiếu secret, 405 sai method, 413 body quá lớn, 400 JSON hỏng', async () => {
  assert.equal((await call('/api/heartbeat', { method: 'POST', body: HB })).status, 401);
  assert.equal((await call('/api/heartbeat', { method: 'POST', headers: { authorization: 'Bearer nope' }, body: HB })).status, 401);
  const auth = { authorization: 'Bearer hb-secret' };
  assert.equal((await call('/api/heartbeat', { headers: auth })).status, 405);
  assert.equal((await call('/api/heartbeat', { method: 'POST', headers: auth, body: { ...HB, pad: 'x'.repeat(20000) } })).status, 413);
  assert.equal((await call('/api/heartbeat', { method: 'POST', headers: auth, body: '{bad' })).status, 400);
  assert.equal((await call('/api/heartbeat', { method: 'POST', headers: auth, body: { nothing: 1 } })).status, 400);
  assert.equal((await call('/api/heartbeat', { method: 'POST', headers: auth, body: HB })).status, 200);
});

test('check: cần key (query hoặc header)', async () => {
  assert.equal((await call('/api/check')).status, 401);
  assert.equal((await call('/api/check?key=sai')).status, 401);
  const r = await call('/api/check?key=chk-secret');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).state, 'alive');
  assert.equal((await call('/api/check', { headers: { 'x-check-key': 'chk-secret' } })).status, 200);
});

test('login → status (cookie) → rerun → agent next/ack', async () => {
  assert.equal((await call('/api/status')).status, 401);
  assert.equal((await call('/api/login', { method: 'POST', body: { password: 'sai' } })).status, 401);
  const r = await call('/api/login', { method: 'POST', body: { password: 'pw123' } });
  assert.equal(r.status, 200);
  const setCookie = r.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = { cookie: setCookie.split(';')[0] };

  const s = await (await call('/api/status', { headers: cookie })).json();
  assert.equal(s.state.status, 'alive');
  assert.ok(!JSON.stringify(s).includes('hb-secret'));

  const rr = await (await call('/api/rerun', { method: 'POST', headers: cookie })).json();
  assert.ok(rr.command);

  assert.equal((await call('/api/agent/next')).status, 401);
  const agent = { authorization: 'Bearer agent-tok' };
  const n = await (await call('/api/agent/next', { headers: agent })).json();
  assert.equal(n.command.id, rr.command);
  assert.equal((await call('/api/agent/ack', { method: 'POST', headers: agent, body: { id: n.command.id } })).status, 200);
  assert.equal((await (await call('/api/agent/next', { headers: agent })).json()).command, null);
});

test('telegram webhook: kiểm tra secret header', async () => {
  assert.equal((await call('/api/telegram', { method: 'POST', body: {} })).status, 401);
  const r = await call('/api/telegram', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'wh-secret' }, body: { message: { chat: { id: 1 }, text: '/status' } } });
  assert.equal(r.status, 200);
});
