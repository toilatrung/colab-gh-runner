import { cleanupOffline, requestRerun, setMute, statusText } from './monitor.js';
import { fmtTime } from './util.js';

const HELP =
  '<b>Lệnh:</b>\n/status – trạng thái runner\n/rerun – yêu cầu chạy lại Colab\n' +
  '/mute [phút] – tắt cảnh báo (mặc định 60)\n/unmute – bật lại cảnh báo\n/cleanup – xoá runner offline trên GitHub';

/** Xử lý một Telegram update. Chỉ phản hồi đúng TELEGRAM_CHAT_ID. */
export async function handleTelegramUpdate(deps, update) {
  const { telegram, cfg } = deps;
  const cb = update?.callback_query;
  const msg = update?.message;
  const chatId = String((cb?.message?.chat?.id ?? msg?.chat?.id) ?? '');
  if (!cfg.telegramChatId || chatId !== cfg.telegramChatId) return { ignored: true };

  if (cb) {
    const m = /^mute:(\d{1,4})$/.exec(cb.data || '');
    if (m) {
      const until = await setMute(deps, Number(m[1]));
      await telegram.answerCallback(cb.id, `Đã tắt báo đến ${fmtTime(until)}`);
      await telegram.send(`🔕 Đã tắt cảnh báo ${m[1]} phút. Dùng /unmute để bật lại.`);
    } else {
      await telegram.answerCallback(cb.id, '');
    }
    return { handled: 'callback' };
  }

  const text = String(msg?.text || '').trim();
  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.split('@')[0].toLowerCase();

  switch (cmd) {
    case '/status':
      await telegram.send(await statusText(deps));
      break;
    case '/rerun': {
      await requestRerun(deps, 'telegram');
      await telegram.send(
        '▶️ Đã đẩy lệnh rerun cho agent local (nếu đang bật).\nNếu không có agent, bấm nút bên dưới và chọn Run all.',
        { buttons: cfg.colabUrl ? [[{ text: '▶️ Mở Colab', url: cfg.colabUrl }]] : undefined },
      );
      break;
    }
    case '/mute': {
      const mins = Math.min(1440, Math.max(1, Number.parseInt(args[0], 10) || 60));
      const until = await setMute(deps, mins);
      await telegram.send(`🔕 Tắt cảnh báo ${mins} phút (đến ${fmtTime(until)}).`);
      break;
    }
    case '/unmute':
      await setMute(deps, 0);
      await telegram.send('🔔 Đã bật lại cảnh báo.');
      break;
    case '/cleanup':
      try {
        const r = await cleanupOffline(deps);
        await telegram.send(`🧹 Đã xoá ${r.removed}/${r.total} runner offline.`);
      } catch (e) {
        await telegram.send(`Không dọn được: ${String(e?.message || e)}`);
      }
      break;
    case '/start':
    case '/help':
      await telegram.send(HELP);
      break;
    default:
      if (text.startsWith('/')) await telegram.send(HELP);
  }
  return { handled: cmd };
}
