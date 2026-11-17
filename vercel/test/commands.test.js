import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleTelegramUpdate } from '../lib/commands.js';
import { handleHeartbeat } from '../lib/monitor.js';
import { makeSession, verifySession, safeEqual, parseCookies } from '../lib/auth.js';
import { makeDeps, hb } from './helpers.js';

const msg = (text, chat = 42) => ({ message: { chat: { id: chat }, text } });

test('chat lạ bị bỏ qua hoàn toàn', async () => {
  const { deps, sent } = makeDeps();
  const r = await handleTelegramUpdate(deps, msg('/status', 999));
  assert.equal(r.ignored, true);
  assert.equal(sent.length, 0);
});

test('/status, /rerun, /mute, /unmute, /cleanup', async () => {
  const { deps, sent, gh } = makeDeps();
  await handleHeartbeat(deps, hb());
  sent.length = 0;

  await handleTelegramUpdate(deps, msg('/status'));
  assert.match(sent.pop().text, /ALIVE/);

  await handleTelegramUpdate(deps, msg('/rerun@mybot'));
  assert.equal((await deps.store.queueList()).length, 1);
  await handleTelegramUpdate(deps, msg('/rerun')); // không đẩy trùng
  assert.equal((await deps.store.queueList()).length, 1);
  sent.length = 0;

  await handleTelegramUpdate(deps, msg('/mute 30'));
  assert.equal((await deps.store.getState()).muted_until, deps.now() + 30 * 60000);
  await handleTelegramUpdate(deps, msg('/unmute'));
  assert.equal((await deps.store.getState()).muted_until, 0);

  await handleTelegramUpdate(deps, msg('/cleanup'));
  assert.deepEqual(gh.deleted, [1]);
});

test('callback nút Tắt báo 1h', async () => {
  const { deps, tg } = makeDeps();
  await handleTelegramUpdate(deps, { callback_query: { id: 'cb1', data: 'mute:60', message: { chat: { id: 42 } } } });
  assert.equal((await deps.store.getState()).muted_until, deps.now() + 3600000);
  assert.equal(tg.callbacks[0].id, 'cb1');
});

test('phiên đăng nhập HMAC: hợp lệ, hết hạn, bị sửa', () => {
  const t = makeSession('s3cret', 1000);
  assert.equal(verifySession('s3cret', t, 2000), true);
  assert.equal(verifySession('s3cret', t, 1000 + 8 * 24 * 3600 * 1000), false);
  assert.equal(verifySession('khac', t, 2000), false);
  assert.equal(verifySession('s3cret', t.replace('v1.', 'v1.9'), 2000), false);
  assert.equal(verifySession('', t, 2000), false);
});

test('safeEqual & parseCookies', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('', ''), false);
  assert.equal(safeEqual(undefined, 'x'), false);
  assert.deepEqual(parseCookies('a=1; cr_session=x.y; bad=%E0%A4%A'), { a: '1', cr_session: 'x.y' });
});
