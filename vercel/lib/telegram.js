const API = 'https://api.telegram.org';

/** Client Telegram tối giản. Mọi lỗi được nuốt (trả false/null) để không làm hỏng luồng chính. */
export function createTelegram(cfg, fetchImpl = fetch) {
  async function call(method, payload) {
    if (!cfg.telegramToken) return null;
    try {
      const r = await fetchImpl(`${API}/bot${cfg.telegramToken}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.ok === false) {
        console.error(`telegram ${method} lỗi`, r.status, j.description || '');
        return null;
      }
      return j;
    } catch (e) {
      console.error(`telegram ${method} ngoại lệ`, e?.name || e);
      return null;
    }
  }

  return {
    /** @returns {Promise<boolean>} true nếu gửi thành công */
    async send(text, { buttons, chatId } = {}) {
      const payload = {
        chat_id: chatId || cfg.telegramChatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      };
      if (buttons?.length) payload.reply_markup = { inline_keyboard: buttons };
      return Boolean(await call('sendMessage', payload));
    },
    async answerCallback(id, text = '') {
      return Boolean(await call('answerCallbackQuery', { callback_query_id: id, text }));
    },
    async setWebhook(url, secret) {
      return call('setWebhook', {
        url,
        secret_token: secret,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true,
      });
    },
  };
}
