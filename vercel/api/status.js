import { buildStatus } from '../lib/monitor.js';
import { json, route } from '../lib/http.js';

export default route({ methods: ['GET'], auth: 'session' }, async (req, res, deps) => {
  json(res, 200, await buildStatus(deps)); // không chứa token/secret
});
