import { makeSession, safeEqual, sessionCookie } from '../lib/auth.js';
import { json, readJson, route } from '../lib/http.js';

export default route({ methods: ['POST'] }, async (req, res, deps) => {
  const { cfg, store } = deps;
  if (!cfg.dashboardPassword || !cfg.sessionSecret) return json(res, 503, { error: 'chưa cấu hình' });
  const ip = String(req.headers['x-forwarded-for'] || 'x').split(',')[0].trim();
  if ((await store.hit(`login:${ip}`, 600)) > 10) return json(res, 429, { error: 'thử lại sau' });
  const body = await readJson(req, 2048);
  if (!safeEqual(String(body.password ?? ''), cfg.dashboardPassword)) {
    return json(res, 401, { error: 'unauthorized' });
  }
  res.setHeader('set-cookie', sessionCookie(makeSession(cfg.sessionSecret)));
  json(res, 200, { ok: true });
});
