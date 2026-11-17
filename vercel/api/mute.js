import { setMute } from '../lib/monitor.js';
import { json, readJson, route } from '../lib/http.js';

// Dashboard: tắt/bật cảnh báo. minutes = 0 → bật lại.
export default route({ methods: ['POST'], auth: 'session' }, async (req, res, deps) => {
  const body = await readJson(req, 1024);
  const minutes = Math.min(1440, Math.max(0, Number.parseInt(body.minutes, 10) || 0));
  json(res, 200, { ok: true, muted_until: await setMute(deps, minutes) });
});
