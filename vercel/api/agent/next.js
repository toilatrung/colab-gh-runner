import { json, route } from '../../lib/http.js';

const TTL_MS = 3600 * 1000;

// Agent local poll: trả lệnh cũ nhất còn hạn (không xoá; agent phải ack).
export default route({ methods: ['GET'], auth: 'agent' }, async (req, res, deps) => {
  const now = deps.now();
  const list = await deps.store.queueList();
  for (const c of list) if (now - c.created >= TTL_MS) await deps.store.queueRemove(c.id);
  const cmd = list.find((c) => now - c.created < TTL_MS) || null;
  json(res, 200, { command: cmd });
});
