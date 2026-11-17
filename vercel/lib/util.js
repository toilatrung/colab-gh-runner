export const escapeHtml = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function fmtDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec} giây`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} phút`;
  const h = Math.floor(m / 60);
  return `${h} giờ ${m % 60} phút`;
}

export function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
}
