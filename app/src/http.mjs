// Loopback HTTP API. /health and the static /ui files are public; every /v1 route needs the bearer token.
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';

export const MAX_BODY_BYTES = 64 * 1024;
export const UI_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; " +
  "base-uri 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'";

const UI_FILES = new Map([
  ['/ui', 'index.html'],
  ['/ui/', 'index.html'],
  ['/ui/index.html', 'index.html'],
  ['/ui/app.js', 'app.js'],
  ['/ui/app.mjs', 'app.mjs'],
  ['/ui/selection.mjs', 'selection.mjs'],
  ['/ui/style.css', 'style.css'],
]);
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
const SESSION_ROUTE = /^\/v1\/sessions\/([A-Za-z0-9_-]{1,128})(\/commands|\/events)?$/;
const HEARTBEAT_MS = 15_000;

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const digest = (value) => createHash('sha256').update(value).digest();

function sendJson(res, status, body, extra = {}) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...BASE_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...extra,
  });
  res.end(payload);
}

function sendError(res, err) {
  const status = Number.isInteger(err?.status) ? err.status : 500;
  const code = status === 500 ? 'internal_error' : err.code ?? 'error';
  const message = status === 500 ? 'internal error' : err.message;
  const body = { error: { code, message } };
  if (status !== 500 && err.details !== undefined) body.error.details = err.details;
  const extra = {};
  if (status === 401) extra['www-authenticate'] = 'Bearer';
  if (status === 413) extra.connection = 'close';
  sendJson(res, status, body, extra);
}

function readJson(req) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    return Promise.reject(new HttpError(415, 'unsupported_media_type', 'content-type must be application/json'));
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return Promise.reject(new HttpError(413, 'body_too_large', `body exceeds ${MAX_BODY_BYTES} bytes`));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        failed = true;
        reject(new HttpError(413, 'body_too_large', `body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
      failed = true;
    });
    req.on('end', () => {
      if (failed) return;
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(new HttpError(400, 'invalid_json', 'body is not valid JSON'));
        return;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        reject(new HttpError(400, 'invalid_json', 'body must be a JSON object'));
        return;
      }
      resolve(value);
    });
  });
}

function parseSeq(value, name) {
  if (value === undefined || value === null || value === '') return 0;
  if (!/^\d{1,15}$/.test(value)) throw new HttpError(400, 'invalid_request', `${name} must be a non-negative integer`);
  return Number(value);
}

export function createHttpServer({ service, token, hostId, uiDir } = {}) {
  if (!service) throw new TypeError('service is required');
  if (typeof token !== 'string' || token.length < 16) throw new TypeError('token must be at least 16 characters');
  const host = hostId ?? service.hostId;
  const tokenDigest = digest(token);
  const streams = new Set();

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err?.status === 413) res.on('finish', () => req.destroy());
      sendError(res, err);
    });
  });

  // The API only ever listens on IPv4 loopback.
  const listen = server.listen.bind(server);
  server.listen = (...args) => {
    const loopback = (value) => {
      if (value === undefined || value === '127.0.0.1' || value === 'localhost') return '127.0.0.1';
      throw new Error(`MyBrowse API only listens on 127.0.0.1, not ${value}`);
    };
    if (args[0] && typeof args[0] === 'object') {
      const [options, ...rest] = args;
      if (options.path !== undefined) throw new Error('MyBrowse API does not listen on a socket path');
      return listen({ ...options, host: loopback(options.host) }, ...rest);
    }
    const [port, ...rest] = args;
    let bindHost;
    if (typeof rest[0] === 'string') bindHost = rest.shift();
    if (typeof rest[0] === 'number') rest.shift();
    return listen({ port, host: loopback(bindHost) }, ...rest);
  };

  server.on('close', () => {
    for (const stream of streams) stream.end();
  });

  function authorities() {
    const port = server.address()?.port;
    return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  }

  function authorize(req) {
    const match = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization ?? ''));
    if (!match || !timingSafeEqual(digest(match[1]), tokenDigest)) {
      throw new HttpError(401, 'unauthorized', 'missing or invalid bearer token');
    }
  }

  async function serveUi(req, res, file) {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed', 'use GET');
    if (!uiDir) throw new HttpError(404, 'not_found', 'UI is not configured');
    let body;
    try {
      body = await readFile(path.join(uiDir, file));
    } catch {
      throw new HttpError(404, 'not_found', 'UI file not found');
    }
    res.writeHead(200, {
      ...BASE_HEADERS,
      'content-type': CONTENT_TYPES[path.extname(file)],
      'content-length': body.length,
      'content-security-policy': UI_CSP,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  function streamEvents(req, res, id, url) {
    service.get(id);
    const lastEventId = req.headers['last-event-id'];
    const after = Math.max(parseSeq(url.searchParams.get('after_seq'), 'after_seq'), parseSeq(lastEventId, 'Last-Event-ID'));
    res.writeHead(200, {
      ...BASE_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    let last = after;
    let replaying = true;
    const buffered = [];
    const write = (event) => {
      if (event.seq <= last) return;
      last = event.seq;
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    // Subscribe before replay so nothing appended in between is lost; seq filtering drops duplicates.
    const unsubscribe = service.subscribe(id, (event) => (replaying ? buffered.push(event) : write(event)));
    for (const event of service.events(id, after)) write(event);
    replaying = false;
    for (const event of buffered) write(event);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    heartbeat.unref();
    streams.add(res);
    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(res);
    };
    res.on('close', cleanup);
  }

  async function handle(req, res) {
    const authority = String(req.headers.host ?? '').toLowerCase();
    if (!authorities().has(authority)) throw new HttpError(421, 'bad_host', 'Host header is not this loopback server');
    const origin = req.headers.origin;
    if (origin !== undefined && !new Set([...authorities()].map((a) => `http://${a}`)).has(origin)) {
      throw new HttpError(403, 'bad_origin', 'cross-origin requests are not allowed');
    }
    const url = new URL(req.url, `http://${authority}`);
    if (url.searchParams.has('token') || url.searchParams.has('access_token')) {
      throw new HttpError(400, 'token_in_url', 'send the token in the Authorization header');
    }

    if (url.pathname === '/health') {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'use GET');
      sendJson(res, 200, { host, capabilities: service.capabilities() });
      return;
    }
    if (UI_FILES.has(url.pathname)) {
      await serveUi(req, res, UI_FILES.get(url.pathname));
      return;
    }
    if (!url.pathname.startsWith('/v1/')) throw new HttpError(404, 'not_found', 'not found');

    authorize(req);

    if (url.pathname === '/v1/sessions') {
      if (req.method === 'GET') {
        sendJson(res, 200, { sessions: service.list() });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (body.host !== undefined && body.host !== host) {
          throw new HttpError(409, 'host_mismatch', `this daemon serves host ${host}`);
        }
        sendJson(res, 200, { session: service.create(body) });
        return;
      }
      throw new HttpError(405, 'method_not_allowed', 'use GET or POST');
    }

    const match = SESSION_ROUTE.exec(url.pathname);
    if (!match) throw new HttpError(404, 'not_found', 'not found');
    const [, id, sub] = match;
    if (!sub) {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'use GET');
      sendJson(res, 200, { session: service.get(id) });
      return;
    }
    if (sub === '/commands') {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'use POST');
      const body = await readJson(req);
      if (body.host !== undefined && body.host !== host) {
        throw new HttpError(409, 'host_mismatch', `this daemon serves host ${host}`);
      }
      const { action, text, expected_revision, request_id } = body;
      sendJson(res, 200, { session: await service.command(id, { action, text, expected_revision, request_id }) });
      return;
    }
    if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'use GET');
    streamEvents(req, res, id, url);
  }

  return server;
}
