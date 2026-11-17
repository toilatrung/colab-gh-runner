const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export function loadConfig(env = process.env) {
  const host = env.PUBLIC_URL || env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL || '';
  const publicUrl = host ? (host.startsWith('http') ? host : `https://${host}`).replace(/\/+$/, '') : '';
  return {
    heartbeatSecret: env.HEARTBEAT_SECRET || '',
    checkSecret: env.CHECK_SECRET || '',
    agentToken: env.AGENT_TOKEN || '',
    dashboardPassword: env.DASHBOARD_PASSWORD || '',
    sessionSecret: env.SESSION_SECRET || '',
    telegramToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: String(env.TELEGRAM_CHAT_ID || ''),
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET || '',
    githubToken: env.GITHUB_TOKEN || '',
    githubRepo: env.GITHUB_REPO || '',
    runnerName: env.RUNNER_NAME || 'colab-runner',
    colabUrl: env.COLAB_URL || '',
    staleAfterSec: int(env.STALE_AFTER_SEC, 300),
    alertRepeatSec: int(env.ALERT_REPEAT_SEC, 1800),
    earlyWarnSec: 15 * 60,
    publicUrl,
    redisUrl: env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || '',
    redisToken: env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || '',
    production: env.VERCEL_ENV === 'production',
  };
}
