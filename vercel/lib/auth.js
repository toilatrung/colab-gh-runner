import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** So sánh constant-time; chuỗi rỗng/thiếu luôn false. */
export function safeEqual(a, b) {
  if (!a || !b) return false;
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export function bearer(req) {
  const h = req.headers?.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const COOKIE = 'cr_session';

const sign = (secret, payload) => createHmac('sha256', secret).update(payload).digest('base64url');

export function makeSession(secret, now = Date.now()) {
  const payload = `v1.${now + SESSION_TTL_MS}`;
  return `${payload}.${sign(secret, payload)}`;
}

export function verifySession(secret, token, now = Date.now()) {
  if (!secret || !token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return false;
  const payload = `${parts[0]}.${parts[1]}`;
  if (!safeEqual(sign(secret, payload), parts[2])) return false;
  return Number(parts[1]) > now;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* bỏ qua */ }
    }
  }
  return out;
}

export function sessionCookie(token, maxAgeSec = SESSION_TTL_MS / 1000) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
}

export const clearCookie = () => sessionCookie('', 0);

export function hasSession(req, cfg, now = Date.now()) {
  const token = parseCookies(req.headers?.cookie || '')[COOKIE];
  return verifySession(cfg.sessionSecret, token, now);
}
