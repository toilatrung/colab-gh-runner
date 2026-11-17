import { handleTelegramUpdate } from '../lib/commands.js';
import { safeEqual } from '../lib/auth.js';
import { json, readJson, route, unauthorized } from '../lib/http.js';

export default route({ methods: ['POST'] }, async (req, res, deps) => {
  if (!safeEqual(req.headers['x-telegram-bot-api-secret-token'], deps.cfg.telegramWebhookSecret)) {
    return unauthorized(res);
  }
  const update = await readJson(req, 64 * 1024);
  await handleTelegramUpdate(deps, update);
  json(res, 200, { ok: true }); // luôn 200 để Telegram không gửi lại
});
