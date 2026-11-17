import { clearCookie } from '../lib/auth.js';
import { json, route } from '../lib/http.js';

export default route({ methods: ['POST'] }, async (req, res) => {
  res.setHeader('set-cookie', clearCookie());
  json(res, 200, { ok: true });
});
