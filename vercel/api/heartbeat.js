import { handleHeartbeat } from '../lib/monitor.js';
import { json, readJson, route } from '../lib/http.js';

export default route({ methods: ['POST'], auth: 'heartbeat' }, async (req, res, deps) => {
  const body = await readJson(req, 16 * 1024);
  const r = await handleHeartbeat(deps, body);
  if (!r.ok) return json(res, 400, { error: 'invalid heartbeat' });
  json(res, 200, { ok: true });
});
