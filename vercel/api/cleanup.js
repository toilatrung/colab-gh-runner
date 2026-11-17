import { cleanupOffline } from '../lib/monitor.js';
import { json, route } from '../lib/http.js';

export default route({ methods: ['POST'], auth: 'session' }, async (req, res, deps) => {
  try {
    json(res, 200, { ok: true, ...(await cleanupOffline(deps)) });
  } catch (e) {
    json(res, 502, { error: String(e?.message || e) });
  }
});
