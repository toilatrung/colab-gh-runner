/**
 * Lớp lưu trữ, hai bản cài đặt cùng giao diện:
 *  - createRedisStore(redis): Upstash Redis (production)
 *  - createMemoryStore(): bộ nhớ trong (test / vercel dev khi chưa có Redis)
 */
export const HISTORY_MAX = 720;
const K = { last: 'hb:last', history: 'hb:history', state: 'state', queue: 'agent:queue' };

export function createMemoryStore() {
  const m = { last: null, state: null, history: [], queue: [], locks: new Map(), hits: new Map() };
  return {
    kind: 'memory',
    async getLast() { return m.last; },
    async setLast(v) { m.last = v; },
    async pushHistory(item) {
      m.history.unshift(item);
      m.history.length = Math.min(m.history.length, HISTORY_MAX);
    },
    async getHistory(n = HISTORY_MAX) { return m.history.slice(0, n); },
    async getState() { return m.state; },
    async setState(v) { m.state = v; },
    async queuePush(cmd) { m.queue.push(cmd); },
    async queueList() { return [...m.queue]; },
    async queueRemove(id) { m.queue = m.queue.filter((c) => c.id !== id); },
    async queueClear() { m.queue = []; },
    async lock(name, ttlSec) {
      const exp = m.locks.get(name);
      if (exp && exp > Date.now()) return false;
      m.locks.set(name, Date.now() + ttlSec * 1000);
      return true;
    },
    async unlock(name) { m.locks.delete(name); },
    async hit(key) {
      const n = (m.hits.get(key) || 0) + 1;
      m.hits.set(key, n);
      return n;
    },
  };
}

// Upstash tự giải mã JSON khi đọc; ta luôn ghi chuỗi JSON và parse nếu còn là chuỗi.
function parse(v) {
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

export function createRedisStore(redis) {
  return {
    kind: 'redis',
    async getLast() { return parse((await redis.get(K.last)) ?? null); },
    async setLast(v) { await redis.set(K.last, JSON.stringify(v)); },
    async pushHistory(item) {
      await redis.lpush(K.history, JSON.stringify(item));
      await redis.ltrim(K.history, 0, HISTORY_MAX - 1);
    },
    async getHistory(n = HISTORY_MAX) {
      return ((await redis.lrange(K.history, 0, n - 1)) || []).map(parse);
    },
    async getState() { return parse((await redis.get(K.state)) ?? null); },
    async setState(v) { await redis.set(K.state, JSON.stringify(v)); },
    async queuePush(cmd) { await redis.rpush(K.queue, JSON.stringify(cmd)); },
    async queueList() { return ((await redis.lrange(K.queue, 0, -1)) || []).map(parse); },
    async queueRemove(id) {
      for (const raw of (await redis.lrange(K.queue, 0, -1)) || []) {
        if (parse(raw)?.id === id) {
          await redis.lrem(K.queue, 0, typeof raw === 'string' ? raw : JSON.stringify(raw));
        }
      }
    },
    async queueClear() { await redis.del(K.queue); },
    async lock(name, ttlSec) {
      return (await redis.set(`lock:${name}`, '1', { nx: true, ex: ttlSec })) === 'OK';
    },
    async unlock(name) { await redis.del(`lock:${name}`); },
    async hit(key, ttlSec) {
      const n = await redis.incr(`hit:${key}`);
      if (n === 1) await redis.expire(`hit:${key}`, ttlSec);
      return n;
    },
  };
}
