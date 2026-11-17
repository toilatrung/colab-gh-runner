import { loadConfig } from '../lib/config.js';
import { createMemoryStore } from '../lib/store.js';

/** Dựng deps giả: store trong bộ nhớ, Telegram/GitHub được mock, đồng hồ điều khiển được. */
export function makeDeps(overrides = {}) {
  const clock = { t: 1_700_000_000_000 };
  const sent = [];
  const gh = {
    runners: [{ id: 1, name: 'colab-runner', status: 'offline', busy: false, labels: [] }],
    queued: 2,
    deleted: [],
    fail: false,
  };
  const tg = { ok: true, callbacks: [] };
  const cfg = {
    ...loadConfig({
      TELEGRAM_CHAT_ID: '42',
      TELEGRAM_BOT_TOKEN: 't',
      COLAB_URL: 'https://colab.example/nb',
      PUBLIC_URL: 'https://app.example',
      STALE_AFTER_SEC: '300',
      ALERT_REPEAT_SEC: '1800',
    }),
    ...overrides,
  };
  const deps = {
    cfg,
    store: createMemoryStore(),
    now: () => clock.t,
    telegram: {
      async send(text, opts) { sent.push({ text, opts }); return tg.ok; },
      async answerCallback(id, text) { tg.callbacks.push({ id, text }); return true; },
    },
    github: {
      async listRunners() { if (gh.fail) throw new Error('GitHub 500'); return gh.runners; },
      async queuedCount() { if (gh.fail) throw new Error('GitHub 500'); return gh.queued; },
      async deleteRunner(id) { gh.deleted.push(id); },
    },
  };
  return { deps, clock, sent, gh, tg, advance: (sec) => { clock.t += sec * 1000; } };
}

export const hb = (extra = {}) => ({
  session_id: 'sess-aaaa-1111',
  event: 'beat',
  runner_name: 'colab-runner',
  runner_state: 'running',
  runner_busy: false,
  session_uptime_sec: 600,
  session_remaining_est_sec: 12 * 3600 - 600,
  cpu: 10, mem: 20, disk: 5, gpus: [],
  ...extra,
});
