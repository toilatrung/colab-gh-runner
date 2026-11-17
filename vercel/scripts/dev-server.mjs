// Server cục bộ nhẹ (không cần tài khoản Vercel): node scripts/dev-server.mjs
// Nạp .env nếu có, dùng bộ nhớ trong khi chưa cấu hình Redis. Chỉ để thử nghiệm.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*?)\s*(?:#.*)?$/.exec(line);
    if (m && m[2] && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

const port = Number(process.env.PORT || 3000);
http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p.startsWith('/api/')) {
    const file = path.join(root, p + '.js');
    if (!file.startsWith(path.join(root, 'api')) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
    return (await import(pathToFileURL(file).href)).default(req, res);
  }
  const f = path.join(root, 'public', p === '/' ? 'index.html' : p);
  if (!f.startsWith(path.join(root, 'public')) || !fs.existsSync(f)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('content-type', f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream');
  res.end(fs.readFileSync(f));
}).listen(port, () => console.log(`Dev server: http://localhost:${port}`));
