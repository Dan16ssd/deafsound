// Zero-dependency static server with correct MIME types (ES modules and the
// AudioWorklet refuse to load as text/plain).
//
//   node serve.mjs 8000                         http on localhost only
//   node serve.mjs --https --host 192.168.0.109 https on the LAN (port 8443)
//
// Options:
//   --port N          default 8000 (http) / 8443 (https)
//   --https           use certs/dev-cert.pem + certs/dev-key.pem
//   --host A[,B]      interfaces to listen on; localhost is always included
//   --narrate URL     POST /narrate is forwarded here (default http://127.0.0.1:8787/),
//                     so an https page on a phone can reach a local `wrangler dev`.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const useHttps = flag('--https');
const port = Number(option('--port', /^\d+$/.test(args[0] ?? '') ? args[0] : useHttps ? 8443 : 8000));
const hosts = ['127.0.0.1', ...option('--host', '').split(',').map((h) => h.trim()).filter(Boolean)];
const narrateUpstream = new URL(option('--narrate', 'http://127.0.0.1:8787/'));

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
  '.bin': 'application/octet-stream',
};

// Allowlist of what the app needs. A blocklist is unsafe here: Windows paths
// are case-insensitive, so "/CERTS/dev-key.pem" would slip past it.
const ALLOWED_FILES = new Set(['index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg', 'sw.js']);
const ALLOWED_DIRS = ['js/', 'model/', 'vendor/'];
function isAllowed(file) {
  const rel = path.relative(root, file).split(path.sep).join('/').toLowerCase();
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  if (rel.split('/').some((part) => part.startsWith('.'))) return false;
  return ALLOWED_FILES.has(rel) || ALLOWED_DIRS.some((d) => rel.startsWith(d));
}

function forwardNarrate(req, res) {
  const upstream = http.request(narrateUpstream, {
    method: req.method,
    headers: { ...req.headers, host: narrateUpstream.host },
  }, (up) => {
    res.writeHead(up.statusCode, up.headers);
    up.pipe(res);
  });
  upstream.on('error', () => {
    res.writeHead(502, { 'content-type': 'application/json' }).end('{"error":"narration_worker_not_running"}');
  });
  req.pipe(upstream);
}

function handler(req, res) {
  // Malformed paths ("//", bad %-escapes) must not crash the server.
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url.replace(/^\/+/, '/'), 'http://x').pathname);
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }
  const log = () => console.log(`${new Date().toISOString().slice(11, 19)} ${req.socket.remoteAddress} ${req.method} ${urlPath} ${res.statusCode}`);
  res.on('finish', log);

  if (urlPath === '/narrate') return forwardNarrate(req, res);
  let file = path.normalize(path.join(root, urlPath));
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!isAllowed(file)) { res.writeHead(404).end('not found'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

const tls = useHttps && {
  cert: fs.readFileSync(path.join(root, 'certs/dev-cert.pem')),
  key: fs.readFileSync(path.join(root, 'certs/dev-key.pem')),
};

for (const host of hosts) {
  const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
  server.listen(port, host, () => {
    const shown = host === '127.0.0.1' ? 'localhost' : host;
    console.log(`DeafSound on ${tls ? 'https' : 'http'}://${shown}:${port}`);
  });
}
