// HGhub 网页版服务端代理（Node 16，纯内置模块，无第三方依赖）
//
// 职责：
//   1. POST /api/edge        —— 业务信封转发：把前端请求封装成 POST /api/edge/request 发给上游
//   2. /hls?u= /seg?u= /img?u= —— 媒体代理：m3u8 改写 + 分片透传 + 封面 AES 解密
//   3. 静态托管 dist/
//
// 上游站点把所有 /api/** 调用收敛成 POST /api/edge/request 的信封（见 src-tauri/src/net.rs），
// 媒体（m3u8/分片/封面）是独立 CDN，封面为 AES-128-CBC 密文（见 src-tauri/src/media.rs）。
//
// 环境变量：
//   PORT     监听端口，默认 3020
//   UPSTREAM 上游基址，默认 https://huangguoai.com
//   STATIC_DIR 静态目录，默认 <本文件>/../dist

'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '3020', 10);
const UPSTREAM = (process.env.UPSTREAM || 'https://huangguoai.com').replace(/\/+$/, '');
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, '..', 'dist');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// 封面 AES-128-CBC 密钥/IV（与 src-tauri/src/media.rs 一致）
const IMG_KEY = Buffer.from('f5d965df75336270', 'ascii');
const IMG_IV = Buffer.from('97b60394abc2fbe1', 'ascii');

/* ───────────────────────── 工具 ───────────────────────── */

function upstreamRequest(method, urlStr, { headers = {}, body = null, timeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          'Accept-Encoding': 'gzip, deflate, br',
          Referer: UPSTREAM + '/',
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let buf = Buffer.concat(chunks);
          const enc = (res.headers['content-encoding'] || '').toLowerCase();
          try {
            if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
            else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
            else if (enc.includes('br')) buf = zlib.brotliDecompressSync(buf);
          } catch (_) {
            /* 解压失败按原样返回 */
          }
          resolve({ status: res.statusCode, headers: res.headers, body: buf });
        });
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// 跟随重定向（最多 5 跳），返回最终响应
async function upstreamGet(urlStr, opts = {}) {
  let url = urlStr;
  for (let hop = 0; hop <= 5; hop++) {
    const r = await upstreamRequest('GET', url, opts);
    if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
      url = new URL(r.headers.location, url).toString();
      continue;
    }
    return r;
  }
  throw new Error('redirect loop');
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  });
  res.end(body);
}

function sendBytes(res, status, ctype, buf, cache = 'public, max-age=3600') {
  res.writeHead(status, {
    'Content-Type': ctype,
    'Content-Length': buf.length,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': cache,
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
}

/* ───────────────────────── 封面解密 ───────────────────────── */

function imageKind(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 4).toString('latin1') === '\x89PNG') return 'image/png';
  if (buf.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function decryptCover(buf) {
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', IMG_KEY, IMG_IV);
    return Buffer.concat([decipher.update(buf), decipher.final()]);
  } catch (_) {
    return buf;
  }
}

/* ───────────────────────── m3u8 改写 ───────────────────────── */

function absolutize(base, target) {
  if (/^https?:\/\//i.test(target)) return target;
  try { return new URL(target, base).toString(); } catch (_) { return target; }
}

// 属性列表按逗号切分，但引号内的逗号不能切
function hlsAttributes(rest) {
  const attrs = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '"') quoted = !quoted;
    if (rest[i] === ',' && !quoted) { attrs.push(rest.slice(start, i)); start = i + 1; }
  }
  attrs.push(rest.slice(start));
  return attrs;
}

function mapUriAttr(line, fn) {
  const idx = line.indexOf(':');
  if (idx < 0) return line;
  const tag = line.slice(0, idx);
  const rest = line.slice(idx + 1);
  const attrs = hlsAttributes(rest).map((attr) => {
    const eq = attr.indexOf('=');
    if (eq < 0) return attr;
    const key = attr.slice(0, eq).trim();
    if (key !== 'URI') return attr;
    const val = attr.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) {
      return `${key}="${fn(val.slice(1, -1))}"`;
    }
    return attr;
  });
  return `${tag}:${attrs.join(',')}`;
}

function rewriteUriAttr(line, origin) {
  return mapUriAttr(line, (uri) => `${origin}/seg?u=${encodeURIComponent(uri)}`);
}

function absolutizeUriAttr(base, line) {
  return mapUriAttr(line, (uri) => absolutize(base, uri));
}

function filterDaterange(line) {
  const idx = line.indexOf(':');
  if (idx < 0) return line;
  const tag = line.slice(0, idx);
  const attrs = hlsAttributes(line.slice(idx + 1)).filter((attr) => {
    const key = attr.split('=')[0].trim().toUpperCase();
    return !key.includes('URI') && key !== 'X-ASSET-LIST';
  });
  return `${tag}:${attrs.join(',')}`;
}

function rewritePlaylist(baseUrl, text, origin) {
  const out = [];
  for (let raw of text.replace(/^\uFEFF/, '').split('\n')) {
    const line = raw.trimEnd();
    if (line === '') { out.push(''); continue; }
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-CONTENT-STEERING:')) continue;
      if (line.startsWith('#EXT-X-DATERANGE:')) { out.push(filterDaterange(line)); continue; }
      if (line.includes('URI="')) {
        out.push(rewriteUriAttr(absolutizeUriAttr(baseUrl, line), origin));
      } else {
        out.push(line);
      }
    } else {
      out.push(`${origin}/seg?u=${encodeURIComponent(absolutize(baseUrl, line))}`);
    }
  }
  return out.join('\n');
}

/* ───────────────────────── 业务信封 ───────────────────────── */

async function edgeRequest(method, apiPath, body, token) {
  const envelope = {
    method,
    path: apiPath,
    body: body ? Buffer.from(JSON.stringify(body)).toString('base64') : '',
    content_type: body ? 'application/json' : '',
  };
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await upstreamRequest('POST', `${UPSTREAM}/api/edge/request`, {
    headers,
    body: Buffer.from(JSON.stringify(envelope)),
  });
  if (r.status === 401 || r.status === 403) return { error: String(r.status) };
  let parsed;
  try { parsed = JSON.parse(r.body.toString('utf8')); }
  catch (_) { return { error: `HTTP ${r.status}: ${r.body.toString('utf8').slice(0, 160)}` }; }
  if (parsed.status === 1) return { data: parsed.data ?? null };
  return { error: (parsed.msg || '接口返回失败') };
}

/* ───────────────────────── 静态托管 ───────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
};

function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(STATIC_DIR, path.normalize(pathname).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(STATIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback：非文件路径回 index.html
      fs.readFile(path.join(STATIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(idx);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ───────────────────────── 路由 ───────────────────────── */

async function handleApi(req, res) {
  if (req.method === 'OPTIONS') { json(res, 204, {}); return; }
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1 << 20) req.destroy(); });
  req.on('end', async () => {
    let payload;
    try { payload = JSON.parse(raw || '{}'); } catch (_) { json(res, 400, { error: 'bad json' }); return; }
    const { method = 'GET', path: apiPath, body, token } = payload;
    if (!apiPath) { json(res, 400, { error: 'missing path' }); return; }
    try {
      const r = await edgeRequest(method, apiPath, body, token);
      if (r.error) json(res, 502, { error: r.error });
      else json(res, 200, r.data ?? null);
    } catch (e) {
      json(res, 502, { error: `upstream error: ${e.message}` });
    }
  });
}

async function handleMedia(path, query, req, res) {
  const target = (query.split('&').find((kv) => kv.startsWith('u=')) || '').slice(2);
  if (!target) { sendBytes(res, 400, 'text/plain', Buffer.from('missing u'), 'no-store'); return; }
  const u = decodeURIComponent(target);
  try {
    if (path === '/img') {
      const r = await upstreamGet(u);
      if (r.status !== 200) { sendBytes(res, 502, 'text/plain', Buffer.from(`HTTP ${r.status}`), 'no-store'); return; }
      let buf = r.body;
      let kind = imageKind(buf);
      if (!kind) { buf = decryptCover(buf); kind = imageKind(buf) || 'image/jpeg'; }
      sendBytes(res, 200, kind, buf, 'public, max-age=86400');
      return;
    }
    const origin = ''; // 同源相对路径：改写后的分片走 /seg?u=
    if (path === '/hls') {
      const r = await upstreamGet(u);
      if (r.status !== 200) { sendBytes(res, 502, 'text/plain', Buffer.from(`HTTP ${r.status}`), 'no-store'); return; }
      const text = r.body.toString('utf8');
      if (!text.replace(/^\uFEFF/, '').startsWith('#EXTM3U')) {
        sendBytes(res, 502, 'text/plain', Buffer.from('not a playlist'), 'no-store');
        return;
      }
      const rewritten = rewritePlaylist(u, text, origin);
      sendBytes(res, 200, 'application/vnd.apple.mpegurl', Buffer.from(rewritten), 'no-store');
      return;
    }
    // /seg：分片 / key / 嵌套 m3u8
    const r = await upstreamGet(u);
    if (r.status !== 200) { sendBytes(res, 502, 'text/plain', Buffer.from(`HTTP ${r.status}`), 'no-store'); return; }
    const ctype = (r.headers['content-type'] || '').toLowerCase();
    const bytes = r.body;
    const isPlaylist = ctype.includes('mpegurl') ||
      bytes.slice(0, 7).toString('latin1') === '#EXTM3U' ||
      bytes.slice(0, 10).toString('latin1') === '\uFEFF#EXTM3U';
    if (isPlaylist) {
      const rewritten = rewritePlaylist(u, bytes.toString('utf8'), origin);
      sendBytes(res, 200, 'application/vnd.apple.mpegurl', Buffer.from(rewritten), 'public, max-age=3600');
    } else {
      const mime = ctype || (u.toLowerCase().split('?')[0].endsWith('.ts') ? 'video/mp2t' : 'application/octet-stream');
      sendBytes(res, 200, mime, bytes, 'public, max-age=3600');
    }
  } catch (e) {
    sendBytes(res, 502, 'text/plain', Buffer.from(`proxy error: ${e.message}`), 'no-store');
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const pathname = u.pathname;
  if (pathname === '/api/edge') { handleApi(req, res); return; }
  if (['/hls', '/seg', '/img'].includes(pathname)) { handleMedia(pathname, u.search.slice(1), req, res); return; }
  if (pathname === '/health') { json(res, 200, { ok: true }); return; }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`HGhub web server listening on :${PORT}, upstream=${UPSTREAM}, static=${STATIC_DIR}`);
});
