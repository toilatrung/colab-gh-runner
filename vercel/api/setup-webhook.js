import { json, route } from '../lib/http.js';

export default route({ methods: ['GET', 'POST'], auth: 'check' }, async (req, res, deps) => {
  const { cfg, telegram } = deps;
  if (!cfg.telegramToken || !cfg.telegramWebhookSecret) {
    return json(res, 400, { error: 'Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_WEBHOOK_SECRET' });
  }
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `https://${host}/api/telegram`; // Telegram chỉ nhận HTTPS
  const r = await telegram.setWebhook(url, cfg.telegramWebhookSecret);
  json(res, r ? 200 : 502, { ok: Boolean(r), webhook: url });
});
