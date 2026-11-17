import { requestRerun } from '../lib/monitor.js';
import { json, route } from '../lib/http.js';

export default route({ methods: ['POST'], auth: 'session' }, async (req, res, deps) => {
  const cmd = await requestRerun(deps, 'dashboard');
  json(res, 200, { ok: true, command: cmd.id, colab_url: deps.cfg.colabUrl });
});
