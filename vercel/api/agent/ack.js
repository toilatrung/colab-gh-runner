import { HttpError, json, readJson, route } from '../../lib/http.js';

export default route({ methods: ['POST'], auth: 'agent' }, async (req, res, deps) => {
  const body = await readJson(req, 1024);
  if (typeof body.id !== 'string' || !body.id) throw new HttpError(400, 'id required');
  await deps.store.queueRemove(body.id);
  json(res, 200, { ok: true });
});
