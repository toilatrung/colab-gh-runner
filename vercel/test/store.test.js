import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedisStore, HISTORY_MAX } from '../lib/store.js';

// Redis giả tối thiểu, mô phỏng hành vi Upstash: lưu chuỗi, trả về giá trị đã parse JSON.
function fakeRedis() {
  const kv = new Map(), lists = new Map();
  const dec = (v) => { try { return JSON.parse(v); } catch { return v; } };
  const L = (k) => lists.get(k) || lists.set(k, []).get(k);
  return {
    async get(k) { return kv.has(k) ? dec(kv.get(k)) : null; },
    async set(k, v, o) { if (o?.nx && kv.has(k)) return null; kv.set(k, v); return 'OK'; },
    async del(k) { kv.delete(k); lists.delete(k); },
    async lpush(k, v) { L(k).unshift(v); },
    async rpush(k, v) { L(k).push(v); },
    async ltrim(k, a, b) { lists.set(k, L(k).slice(a, b + 1)); },
    async lrange(k, a, b) { const l = L(k); return l.slice(a, b === -1 ? undefined : b + 1).map(dec); },
    async lrem(k, n, v) { lists.set(k, L(k).filter((x) => x !== v)); },
    async incr(k) { const n = (Number(kv.get(k)) || 0) + 1; kv.set(k, String(n)); return n; },
    async expire() {},
  };
}

test('redis store: last/state/history/queue/lock', async () => {
  const s = createRedisStore(fakeRedis());
  assert.equal(await s.getLast(), null);
  await s.setLast({ time: 1, session_id: 'a' });
  assert.deepEqual(await s.getLast(), { time: 1, session_id: 'a' });
  await s.setState({ status: 'alive' });
  assert.equal((await s.getState()).status, 'alive');

  for (let i = 0; i < HISTORY_MAX + 5; i++) await s.pushHistory({ t: i });
  const h = await s.getHistory();
  assert.equal(h.length, HISTORY_MAX);
  assert.equal(h[0].t, HISTORY_MAX + 4); // mới nhất đứng đầu

  await s.queuePush({ id: 'a', type: 'rerun', created: 1 });
  await s.queuePush({ id: 'b', type: 'rerun', created: 2 });
  await s.queueRemove('a');
  assert.deepEqual((await s.queueList()).map((c) => c.id), ['b']);
  await s.queueClear();
  assert.equal((await s.queueList()).length, 0);

  assert.equal(await s.lock('x', 10), true);
  assert.equal(await s.lock('x', 10), false);
  await s.unlock('x');
  assert.equal(await s.lock('x', 10), true);
  assert.equal(await s.hit('k', 60), 1);
  assert.equal(await s.hit('k', 60), 2);
});
