import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { HttpError } from './util.js';

const MAX_BODY_BYTES = 32 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

export const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

/** Lets a route answer with something other than JSON (e.g. a CSV download). */
export class RawResponse {
  constructor(status, headers, body) {
    Object.assign(this, { status, headers, body });
  }
}

export function sendJson(res, status, data, headers = {}) {
  const body = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* a malformed cookie is ignored rather than failing the request */
    }
  }
  return out;
}

export function readJson(req) {
  return new Promise((resolve, reject) => {
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const declared = Number(req.headers['content-length'] || 0);
    if (!declared && !req.headers['transfer-encoding']) return resolve({});
    if (type !== 'application/json') return reject(new HttpError(415, 'unsupported', 'Send JSON.'));
    if (declared > MAX_BODY_BYTES) return reject(new HttpError(413, 'too_large', 'That request is too large.'));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'too_large', 'That request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'bad_json', "We couldn't read that request."));
      }
    });
    req.on('error', reject);
  });
}

/** Tiny method + path router with :params. */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, options, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern.replace(/:([A-Za-z]+)/g, (_, k) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '/?$',
    );
    this.routes.push({ method, regex, keys, options, handler });
  }

  match(method, path) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.regex.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      try {
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      } catch {
        throw new HttpError(400, 'bad_request', "That address isn't valid.");
      }
      return { route: r, params };
    }
    return { route: null, pathMatched };
  }
}

export function serveStatic(rootDir, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  let file = normalize(join(rootDir, pathname));
  if (file !== rootDir && !file.startsWith(rootDir + sep)) {
    res.writeHead(403);
    return res.end();
  }
  let stat;
  try {
    stat = statSync(file);
    if (stat.isDirectory()) {
      file = join(file, 'index.html');
      stat = statSync(file);
    }
  } catch {
    // Single-page app: unknown paths without an extension fall back to the shell.
    if (extname(pathname)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    file = join(rootDir, 'index.html');
    stat = statSync(file);
  }
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    return res.end();
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    ETag: etag,
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

/**
 * Vercel rewrites /api/* to the single function at /api and passes the original path along as ?path=a/b/c.
 * Depending on the platform version the function may see either the original or the rewritten URL, so accept
 * both: if we were handed the bare /api URL with a `path` parameter, rebuild the real one.
 */
export function restoreApiUrl(req) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/api' && url.pathname !== '/api/') return;
  const path = url.searchParams.get('path');
  if (path === null) return;
  url.searchParams.delete('path');
  const segments = path.split('/').filter((seg) => seg && seg !== '.' && seg !== '..').map(encodeURIComponent);
  req.url = `/api${segments.length ? '/' + segments.join('/') : ''}${url.search}`;
}
