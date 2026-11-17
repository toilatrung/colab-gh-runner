import { loadConfig } from './config.js';
import { createGithub } from './github.js';
import { createMemoryStore, createRedisStore } from './store.js';
import { createTelegram } from './telegram.js';

let cached;

/** Dựng dependency thật từ biến môi trường (cache theo instance). */
export function getDeps() {
  if (cached) return cached;
  const cfg = loadConfig();
  let store;
  if (cfg.redisUrl && cfg.redisToken) {
    // import động để test không cần cài @upstash/redis
    store = lazyRedisStore(cfg);
  } else if (cfg.production) {
    throw new Error('Thiếu cấu hình Upstash Redis (KV_REST_API_URL/KV_REST_API_TOKEN)');
  } else {
    console.warn('[dev] Không có Redis → dùng bộ nhớ trong (mất khi khởi động lại)');
    store = createMemoryStore();
  }
  cached = {
    cfg,
    store,
    telegram: createTelegram(cfg),
    github: createGithub(cfg),
    now: () => Date.now(),
  };
  return cached;
}

function lazyRedisStore(cfg) {
  let inner;
  const get = async () => {
    if (!inner) {
      const { Redis } = await import('@upstash/redis');
      inner = createRedisStore(new Redis({ url: cfg.redisUrl, token: cfg.redisToken }));
    }
    return inner;
  };
  return new Proxy({ kind: 'redis' }, {
    get: (t, name) => (name === 'kind' ? 'redis' : async (...a) => (await get())[name](...a)),
  });
}
