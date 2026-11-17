import { hasSession, safeEqual, bearer } from './auth.js';
import { getDeps } from './deps.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message || String(status));
    this.status = status;
  }
}

export function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(obj));
}

export const unauthorized = (res) => json(res, 401, { error: 'unauthorized' });

/** Đọc JSON body với giới hạn kích thước (mặc định 16KB). */
export async function readJson(req, limit = 16 * 1024) {
  if (Number(req.headers['content-length'] || 0) > limit) throw new HttpError(413, 'too large');
  let text;
  if (req.readableEnded) {
    const b = req.body;
    if (b == null) return {};
    text = typeof b === 'string' ? b : JSON.stringify(b);
    if (text.length > limit) throw new HttpError(413, 'too large');
  } else {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new HttpError(413, 'too large');
      chunks.push(c);
    }
    text = Buffer.concat(chunks).toString('utf8');
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

export const query = (req) => new URL(req.url, 'http://x').searchParams;

/**
 * Bọc handler: kiểm tra method, bắt lỗi (không lộ chi tiết), tạo deps.
 * opts.auth: 'none' | 'session' | 'heartbeat' | 'check' | 'agent'
 */
export function route({ methods, auth = 'none' }, fn) {
  return async function handler(req, res) {
    try {
      if (!methods.includes(req.method)) {
        res.setHeader('allow', methods.join(', '));
        return json(res, 405, { error: 'method not allowed' });
      }
      const deps = getDeps();
      const { cfg } = deps;
      if (auth === 'session' && !hasSession(req, cfg)) return unauthorized(res);
      if (auth === 'heartbeat' && !safeEqual(bearer(req), cfg.heartbeatSecret)) return unauthorized(res);
      if (auth === 'agent' && !safeEqual(bearer(req), cfg.agentToken)) return unauthorized(res);
      if (auth === 'check') {
        const key = query(req).get('key') || req.headers['x-check-key'] || bearer(req);
        if (!safeEqual(key, cfg.checkSecret)) return unauthorized(res);
      }
      return await fn(req, res, deps);
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      console.error('handler lỗi:', e?.stack || e);
      return json(res, 500, { error: 'internal error' });
    }
  };
}
