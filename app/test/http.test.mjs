// HTTP boundary checks with a fake engine (not a real LLM run). Requests go through the real
// node:http server and client over an in-memory socket pair, because the test sandbox may forbid
// binding even a loopback port. Only server.address() is stubbed; the TCP bind is not exercised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Duplex } from 'node:stream';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { SessionService } from '../src/service.mjs';
import { createHttpServer, MAX_BODY_BYTES, UI_CSP } from '../src/http.mjs';

const HOST = 'imac';
const TOKEN = 'test-token-0123456789abcdef';

class FakeEngine {
  calls = [];
  start(session, cb) {
    const call = { session, cb, stops: 0 };
    call.handle = { stop: async () => void call.stops++ };
    this.calls.push(call);
    return Promise.resolve(call.handle);
  }
}

async function startServer(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mybrowse-http-'));
  const uiDir = path.join(dir, 'ui');
  mkdirSync(uiDir);
  writeFileSync(path.join(uiDir, 'index.html'), '<!doctype html><title>MyBrowse</title>');
  writeFileSync(path.join(uiDir, 'app.js'), 'console.log(1);');
  writeFileSync(path.join(uiDir, 'style.css'), 'body{}');
  writeFileSync(path.join(dir, 'secret.txt'), 'do not serve');
  const engine = new FakeEngine();
  const service = new SessionService({ store: new Store(path.join(dir, 's.db'), HOST), engines: { codex: engine } });
  const server = createHttpServer({ service, token: TOKEN, hostId: HOST, uiDir });
  const port = FAKE_PORT;
  server.address = () => ({ address: '127.0.0.1', family: 'IPv4', port });
  servers.set(port, server);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    server.emit('close');
    servers.delete(port);
    await service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { server, service, engine, port, origin: `http://127.0.0.1:${port}` };
}

const FAKE_PORT = 48123;
const servers = new Map();
const sockets = new Set();

function socketPair() {
  const make = () =>
    new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        this.peer.push(chunk);
        cb();
      },
      final(cb) {
        this.peer.push(null);
        cb();
      },
      destroy(err, cb) {
        setImmediate(() => this.peer.destroy());
        cb(err);
      },
    });
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  for (const s of [a, b]) {
    s.remoteAddress = '127.0.0.1';
    s.setTimeout = () => s;
    s.setNoDelay = () => s;
    s.setKeepAlive = () => s;
    s.ref = () => s;
    s.unref = () => s;
    sockets.add(s);
  }
  return [a, b];
}

// Hands the server one end of a fresh socket pair and returns the client end.
function connect(port) {
  const [client, serverSide] = socketPair();
  servers.get(port).emit('connection', serverSide);
  return client;
}

// Raw request so tests control Host/Origin headers exactly.
function request(port, { method = 'GET', path: p = '/', headers = {}, body, auth = true, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const allHeaders = { host: `127.0.0.1:${port}`, ...headers };
    if (auth) allHeaders.authorization = `Bearer ${TOKEN}`;
    let payload;
    if (body !== undefined) {
      payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      allHeaders['content-type'] ??= 'application/json';
      if (!chunked) allHeaders['content-length'] = Buffer.byteLength(payload);
    }
    // No agent: ClientRequest then uses createConnection directly.
    const options = { createConnection: () => connect(port), method, path: p, headers: allHeaders };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

let counter = 0;
const newSession = (extra = {}) => ({
  prompt: 'read the title',
  engine: 'codex',
  mode: 'chat',
  client_id: 'muse',
  request_id: `http-${++counter}`,
  ...extra,
});

// Opens an SSE stream and resolves once `count` events arrived.
function readSse(port, sessionPath, { count, headers = {} }) {
  return new Promise((resolve, reject) => {
    const events = [];
    const req = http.request(
      {
        createConnection: () => connect(port),
        path: sessionPath,
        headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream', ...headers },
      },
      (res) => {
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /^text\/event-stream/);
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const id = /^id: (\d+)$/m.exec(block);
            const data = /^data: (.*)$/m.exec(block);
            if (id && data) events.push({ id: Number(id[1]), ...JSON.parse(data[1]) });
          }
          if (events.length >= count) {
            req.destroy();
            resolve(events);
          }
        });
      },
    );
    req.on('error', (err) => (events.length >= count ? undefined : reject(err)));
    req.end();
  });
}

test('health is public and reports host and honest capabilities', async (t) => {
  const { port } = await startServer(t);
  const res = await request(port, { path: '/health', auth: false });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ['capabilities', 'host']);
  assert.equal(res.json.host, HOST);
  assert.equal(res.json.capabilities.browser, false);
  assert.equal(res.json.capabilities.opencodex, false);
  assert.equal(res.json.capabilities.queue_boundary, 'turn_end');
  assert.deepEqual(res.json.capabilities.engines, ['codex']);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('/v1 requires the bearer token; tokens in the URL are refused', async (t) => {
  const { port } = await startServer(t);
  const none = await request(port, { path: '/v1/sessions', auth: false });
  assert.equal(none.status, 401);
  assert.equal(none.headers['www-authenticate'], 'Bearer');
  const wrong = await request(port, { path: '/v1/sessions', auth: false, headers: { authorization: 'Bearer wrong-token-xxxxxxxx' } });
  assert.equal(wrong.status, 401);
  const inUrl = await request(port, { path: `/v1/sessions?token=${TOKEN}`, auth: false });
  assert.equal(inUrl.status, 400);
  assert.equal(inUrl.json.error.code, 'token_in_url');
  assert.ok(!inUrl.text.includes(TOKEN));
  const ok = await request(port, { path: '/v1/sessions' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { sessions: [] });
});

test('foreign Origin and Host headers are rejected, even with a valid token', async (t) => {
  const { port, origin } = await startServer(t);
  const evil = await request(port, { path: '/v1/sessions', headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  const nullOrigin = await request(port, { path: '/health', auth: false, headers: { origin: 'null' } });
  assert.equal(nullOrigin.status, 403);
  const rebinding = await request(port, { path: '/v1/sessions', headers: { host: `evil.example:${port}` } });
  assert.equal(rebinding.status, 421);
  const otherPort = await request(port, { path: '/health', auth: false, headers: { host: '127.0.0.1:1' } });
  assert.equal(otherPort.status, 421);
  const same = await request(port, { path: '/v1/sessions', headers: { origin } });
  assert.equal(same.status, 200);
  const local = await request(port, { path: '/v1/sessions', headers: { host: `localhost:${port}`, origin: `http://localhost:${port}` } });
  assert.equal(local.status, 200);
});

test('JSON bodies are size-limited, typed and validated', async (t) => {
  const { port } = await startServer(t);
  const big = await request(port, {
    method: 'POST',
    path: '/v1/sessions',
    body: JSON.stringify(newSession({ prompt: 'x'.repeat(MAX_BODY_BYTES) })),
  });
  assert.equal(big.status, 413);
  // Without Content-Length the limit is enforced while streaming.
  const bigChunked = await request(port, {
    method: 'POST',
    path: '/v1/sessions',
    chunked: true,
    body: JSON.stringify(newSession({ prompt: 'y'.repeat(MAX_BODY_BYTES) })),
  });
  assert.equal(bigChunked.status, 413);
  assert.equal(bigChunked.json.error.code, 'body_too_large');
  const badType = await request(port, { method: 'POST', path: '/v1/sessions', body: '{}', headers: { 'content-type': 'text/plain' } });
  assert.equal(badType.status, 415);
  const badJson = await request(port, { method: 'POST', path: '/v1/sessions', body: '{"prompt":' });
  assert.equal(badJson.status, 400);
  const array = await request(port, { method: 'POST', path: '/v1/sessions', body: [] });
  assert.equal(array.status, 400);
  const badEngine = await request(port, { method: 'POST', path: '/v1/sessions', body: newSession({ engine: 'opencodex' }) });
  assert.equal(badEngine.status, 400);
  const list = await request(port, { path: '/v1/sessions' });
  assert.equal(list.json.sessions.length, 0);
});

test('create, duplicate, conflict and host mismatch over HTTP', async (t) => {
  const { port, engine } = await startServer(t);
  const body = newSession();
  const a = await request(port, { method: 'POST', path: '/v1/sessions', body });
  assert.equal(a.status, 200);
  assert.equal(a.json.session.status, 'running');
  assert.equal(a.json.session.host, HOST);
  const b = await request(port, { method: 'POST', path: '/v1/sessions', body });
  assert.equal(b.json.session.id, a.json.session.id);
  assert.equal(engine.calls.length, 1);
  const conflict = await request(port, { method: 'POST', path: '/v1/sessions', body: { ...body, prompt: 'other' } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, 'request_conflict');
  const badHost = await request(port, { method: 'POST', path: '/v1/sessions', body: newSession({ host: 'macbook' }) });
  assert.equal(badHost.status, 409);
  assert.equal(badHost.json.error.code, 'host_mismatch');

  const browser = await request(port, { method: 'POST', path: '/v1/sessions', body: newSession({ mode: 'browser' }) });
  assert.equal(browser.json.session.status, 'waiting_user');

  const one = await request(port, { path: `/v1/sessions/${a.json.session.id}` });
  assert.deepEqual(Object.keys(one.json), ['session']);
  assert.equal((await request(port, { path: '/v1/sessions/nope' })).status, 404);
  const list = await request(port, { path: '/v1/sessions' });
  assert.equal(list.json.sessions.length, 2);
});

test('commands: required fields, stale revision, replay and host mismatch', async (t) => {
  const { port, engine } = await startServer(t);
  const created = (await request(port, { method: 'POST', path: '/v1/sessions', body: newSession() })).json.session;
  await new Promise((resolve) => setImmediate(resolve));
  const commandPath = `/v1/sessions/${created.id}/commands`;

  const missing = await request(port, { method: 'POST', path: commandPath, body: { action: 'stop', request_id: 'c0' } });
  assert.equal(missing.status, 400);
  const stale = await request(port, {
    method: 'POST',
    path: commandPath,
    body: { action: 'stop', request_id: 'c1', expected_revision: created.revision - 1 },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, 'stale_revision');
  const unsupported = await request(port, {
    method: 'POST',
    path: commandPath,
    body: { action: 'steer', text: 'x', request_id: 'c2', expected_revision: created.revision },
  });
  assert.equal(unsupported.status, 409);
  assert.equal(unsupported.json.error.code, 'unsupported');
  const otherHost = await request(port, {
    method: 'POST',
    path: commandPath,
    body: { action: 'stop', request_id: 'c3', expected_revision: created.revision, host: 'macbook' },
  });
  assert.equal(otherHost.status, 409);

  const stopBody = { action: 'stop', request_id: 'c4', expected_revision: created.revision };
  const stopped = await request(port, { method: 'POST', path: commandPath, body: stopBody });
  assert.equal(stopped.status, 200);
  assert.deepEqual(Object.keys(stopped.json), ['session']);
  assert.equal(stopped.json.session.status, 'paused');
  assert.equal(stopped.json.session.revision, created.revision + 1);
  const replay = await request(port, { method: 'POST', path: commandPath, body: stopBody });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.session.revision, created.revision + 1);
  assert.equal(engine.calls[0].stops, 1, 'replayed stop is not executed again');
  const mismatch = await request(port, { method: 'POST', path: commandPath, body: { ...stopBody, expected_revision: 99 } });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.json.error.code, 'request_conflict');
});

test('SSE replays stored events after after_seq / Last-Event-ID and streams new ones', async (t) => {
  const { port, engine } = await startServer(t);
  const created = (await request(port, { method: 'POST', path: '/v1/sessions', body: newSession() })).json.session;
  const eventsPath = `/v1/sessions/${created.id}/events`;
  // Stored: created(1), turn_started(2).
  const all = await readSse(port, eventsPath, { count: 2 });
  assert.deepEqual(all.map((e) => [e.id, e.seq, e.type]), [[1, 1, 'created'], [2, 2, 'turn_started']]);

  const live = readSse(port, `${eventsPath}?after_seq=1`, { count: 3 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  engine.calls[0].cb.onEvent('assistant_delta', { text: 'hi' });
  engine.calls[0].cb.onEnd({ status: 'done', result: { text: 'hi' } });
  const got = await live;
  assert.deepEqual(got.map((e) => e.type), ['turn_started', 'engine.assistant_delta', 'turn_ended']);

  const resumed = await readSse(port, eventsPath, { count: 1, headers: { 'last-event-id': '3' } });
  assert.deepEqual(resumed.map((e) => e.seq), [4]);
  const bad = await request(port, { path: `${eventsPath}?after_seq=-1` });
  assert.equal(bad.status, 400);
  const noAuth = await request(port, { path: eventsPath, auth: false });
  assert.equal(noAuth.status, 401);
});

test('static UI is served without a token, with CSP, and only the allowlisted files', async (t) => {
  const { port } = await startServer(t);
  for (const [p, type] of [
    ['/ui/', /^text\/html/],
    ['/ui/app.js', /^text\/javascript/],
    ['/ui/style.css', /^text\/css/],
  ]) {
    const res = await request(port, { path: p, auth: false });
    assert.equal(res.status, 200, p);
    assert.match(res.headers['content-type'], type);
    assert.equal(res.headers['content-security-policy'], UI_CSP);
    assert.equal(res.headers['x-frame-options'], 'DENY');
  }
  assert.equal((await request(port, { path: '/ui/../secret.txt', auth: false })).status, 404);
  assert.equal((await request(port, { path: '/ui/%2e%2e/secret.txt', auth: false })).status, 404);
  assert.equal((await request(port, { path: '/ui/s.db', auth: false })).status, 404);
});

test('server refuses to listen on a non-loopback address', async (t) => {
  const { service } = await startServer(t);
  const server = createHttpServer({ service, token: TOKEN, hostId: HOST });
  assert.throws(() => server.listen(0, '0.0.0.0'), /127\.0\.0\.1/);
  assert.throws(() => server.listen({ port: 0, host: '::' }), /127\.0\.0\.1/);
  assert.throws(() => createHttpServer({ service, token: 'short' }), /token/);
});
