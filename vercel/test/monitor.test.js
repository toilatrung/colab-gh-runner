import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleHeartbeat, runCheck, setMute, sanitizeHeartbeat } from '../lib/monitor.js';
import { makeDeps, hb } from './helpers.js';

const texts = (sent) => sent.map((s) => s.text);

test('heartbeat đầu tiên: unknown → alive, event start gửi 🚀', async () => {
  const { deps, sent } = makeDeps();
  const r = await handleHeartbeat(deps, hb({ event: 'start' }));
  assert.equal(r.ok, true);
  assert.equal((await deps.store.getState()).status, 'alive');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Phiên Colab mới/);
  // beat tiếp theo cùng phiên: im lặng
  await handleHeartbeat(deps, hb());
  assert.equal(sent.length, 1);
});

test('heartbeat không hợp lệ bị từ chối; dữ liệu được rút gọn', async () => {
  const { deps } = makeDeps();
  assert.equal((await handleHeartbeat(deps, { foo: 1 })).ok, false);
  const c = sanitizeHeartbeat({ session_id: 'x'.repeat(500), gpus: new Array(50).fill({ util: 5 }), cpu: 'abc', event: 'hack' });
  assert.equal(c.session_id.length, 64);
  assert.equal(c.gpus.length, 8);
  assert.equal(c.cpu, undefined);
  assert.equal(c.event, 'beat');
});

test('chưa có heartbeat nào: check không báo động', async () => {
  const { deps, sent } = makeDeps();
  const r = await runCheck(deps);
  assert.equal(r.state, 'unknown');
  assert.equal(sent.length, 0);
});

test('alive → dead: cảnh báo 1 lần, kèm lý do + nút, đẩy lệnh rerun', async () => {
  const { deps, sent, advance } = makeDeps();
  await handleHeartbeat(deps, hb());
  sent.length = 0;
  advance(200);
  assert.deepEqual((await runCheck(deps)).actions, []); // chưa quá ngưỡng 300s
  advance(150); // 350s
  const r = await runCheck(deps);
  assert.equal(r.state, 'dead');
  assert.deepEqual(r.actions, ['dead', 'alert']);
  assert.equal(sent.length, 1);
  const msg = sent[0];
  assert.match(msg.text, /Colab runner đã dừng/);
  assert.match(msg.text, /Heartbeat cuối/);
  assert.match(msg.text, /offline/); // trạng thái GitHub runner
  assert.match(msg.text, /Job đang chờ.*2/);
  const flat = msg.opts.buttons.flat();
  assert.ok(flat.some((b) => b.url === 'https://colab.example/nb'));
  assert.ok(flat.some((b) => b.callback_data === 'mute:60'));
  const q = await deps.store.queueList();
  assert.equal(q.length, 1);
  assert.equal(q[0].type, 'rerun');
});

test('gọi /api/check trùng không gửi tin trùng và không đẩy thêm lệnh', async () => {
  const { deps, sent, advance } = makeDeps();
  await handleHeartbeat(deps, hb());
  sent.length = 0;
  advance(400);
  await runCheck(deps);
  advance(60);
  const r2 = await runCheck(deps);
  advance(60);
  await runCheck(deps);
  assert.equal(sent.length, 1);
  assert.ok(r2.actions.includes('wait'));
  assert.equal((await deps.store.queueList()).length, 1);
});

test('gọi đồng thời: khoá chặn lần thứ hai', async () => {
  const { deps, advance } = makeDeps();
  await handleHeartbeat(deps, hb());
  advance(400);
  const [a, b] = await Promise.all([runCheck(deps), runCheck(deps)]);
  assert.ok([a, b].some((r) => r.skipped === 'locked'));
});

test('vẫn dead: nhắc lại mỗi ALERT_REPEAT_SEC', async () => {
  const { deps, sent, advance } = makeDeps();
  await handleHeartbeat(deps, hb());
  sent.length = 0;
  advance(400);
  await runCheck(deps); // alert #1
  advance(1799);
  await runCheck(deps); // chưa tới hạn
  assert.equal(sent.length, 1);
  advance(2);
  const r = await runCheck(deps); // đủ 1800s
  assert.deepEqual(r.actions, ['reminder']);
  assert.equal(sent.length, 2);
  assert.match(sent[1].text, /vẫn đang dừng.*lần 2/);
});

test('mute: không nhắc khi đang tắt báo, hết hạn thì báo lại', async () => {
  const { deps, sent, advance } = makeDeps();
  await handleHeartbeat(deps, hb());
  sent.length = 0;
  advance(400);
  await runCheck(deps); // alert #1
  await setMute(deps, 60);
  advance(1900);
  assert.deepEqual((await runCheck(deps)).actions, ['muted']);
  advance(3600); // hết mute
  assert.deepEqual((await runCheck(deps)).actions, ['reminder']);
  assert.equal(sent.length, 2);
});

test('mute trước khi dead: hoãn cảnh báo đầu tiên tới khi hết mute', async () => {
  const { deps, sent, advance } = makeDeps();
  await handleHeartbeat(deps, hb());
  sent.length = 0;
  await setMute(deps, 10);
  advance(400);
  assert.deepEqual((await runCheck(deps)).actions, ['dead', 'muted']);
  assert.equal(sent.length, 0);
  advance(600);
  assert.deepEqual((await runCheck(deps)).actions, ['alert']);
});

test('dead → alive qua heartbeat: gửi ✅, xoá hàng đợi, không gửi 🚀 thêm', async () => {
  const { deps, sent, advance } = makeDeps();
  await handleHeartbeat(deps, hb());
  advance(400);
  await runCheck(deps);
  sent.length = 0;
  const r = await handleHeartbeat(deps, hb({ session_id: 'sess-bbbb-2222', event: 'start' }));
  assert.equal(r.notified, 'recovered');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /đã online lại/);
  assert.match(sent[0].text, /sess-bbb/);
  assert.equal((await deps.store.getState()).status, 'alive');
  assert.equal((await deps.store.queueList()).length, 0);
  // check sau đó: im lặng
  assert.deepEqual((await runCheck(deps)).actions, []);
  assert.equal(sent.length, 1);
});

test('event stopping: coi là dead ngay, không cần chờ stale', async () => {
  const { deps, sent } = makeDeps();
  await handleHeartbeat(deps, hb());
  sent.length = 0;
  await handleHeartbeat(deps, hb({ event: 'stopping', runner_state: 'stopped' }));
  const r = await runCheck(deps);
  assert.equal(r.state, 'dead');
  assert.match(sent[0].text, /stopping/);
});

test('cảnh báo sắp hết phiên: một lần/phiên, phiên mới được báo lại', async () => {
  const { deps, sent, advance } = makeDeps();
  await handleHeartbeat(deps, hb({ session_remaining_est_sec: 1000 }));
  sent.length = 0;
  assert.deepEqual((await runCheck(deps)).actions, []); // 1000s > 900s
  advance(120);
  await handleHeartbeat(deps, hb({ session_remaining_est_sec: 880 }));
  const r = await runCheck(deps);
  assert.deepEqual(r.actions, ['early_warning']);
  assert.match(sent[0].text, /sắp hết/);
  advance(60);
  await handleHeartbeat(deps, hb({ session_remaining_est_sec: 820 }));
  assert.deepEqual((await runCheck(deps)).actions, []); // không lặp
  assert.equal(sent.length, 1);
  // phiên mới
  await handleHeartbeat(deps, hb({ session_id: 'sess-new', event: 'start', session_remaining_est_sec: 600 }));
  sent.length = 0;
  assert.deepEqual((await runCheck(deps)).actions, ['early_warning']);
});

test('Telegram lỗi: giữ nguyên để lần check sau gửi lại, không mất cảnh báo', async () => {
  const { deps, sent, tg, advance } = makeDeps();
  await handleHeartbeat(deps, hb());
  sent.length = 0;
  tg.ok = false;
  advance(400);
  assert.deepEqual((await runCheck(deps)).actions, ['dead', 'alert_failed']);
  tg.ok = true;
  advance(60);
  assert.deepEqual((await runCheck(deps)).actions, ['alert']);
});

test('GitHub lỗi vẫn gửi cảnh báo (ghi chú lỗi)', async () => {
  const { deps, sent, gh, advance } = makeDeps();
  await handleHeartbeat(deps, hb());
  sent.length = 0;
  gh.fail = true;
  advance(400);
  await runCheck(deps);
  assert.match(sent[0].text, /GitHub: không đọc được/);
});

test('GitHub báo online dù mất heartbeat: có ghi chú cảnh báo', async () => {
  const { deps, sent, gh, advance } = makeDeps();
  gh.runners[0].status = 'online';
  await handleHeartbeat(deps, hb());
  sent.length = 0;
  advance(400);
  await runCheck(deps);
  assert.match(sent[0].text, /vẫn thấy runner online/);
});
