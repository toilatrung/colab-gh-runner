import { runCheck } from '../lib/monitor.js';
import { json, route } from '../lib/http.js';

// cron-job.org gọi GET mỗi phút: /api/check?key=CHECK_SECRET
export default route({ methods: ['GET', 'POST'], auth: 'check' }, async (req, res, deps) => {
  json(res, 200, await runCheck(deps));
});
