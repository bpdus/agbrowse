// IPC checks over real Unix sockets with a fake engine (no real LLM run, no official credentials).
// Full startIpcServer tests need a short socket path (macOS limit: 103 bytes). Set
// MYBROWSE_IPC_TEST_DIR to a short, existing, non-symlink directory such as /private/tmp (macOS /tmp is a symlink). Without it the
// connection-level tests bind a relative socket inside the work-folder temp dir, and the
// startIpcServer tests are reported as skipped; a skip is not a pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { SessionService } from '../src/service.mjs';
import { attachIpcConnection, startIpcServer, MAX_FRAME_BYTES } from '../src/ipc.mjs';

const HOST = 'imac';
const TOKEN = 'test-token-0123456789abcdef';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHORT_DIR = process.env.MYBROWSE_IPC_TEST_DIR;
const NO_SHORT = SHORT_DIR ? false : 'MYBROWSE_IPC_TEST_DIR is not set; the work path is too long for a Unix socket';

class FakeEngine {
  calls = [];
  start(session, cb) {
    const call = { session, cb };
    call.handle = { stop: async () => {} };
    this.calls.push(call);
    return Promise.resolve(call.handle);
  }
}

const frame = (obj) => {
  const body = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
};
const req = (op, payload = {}, extra = {}) => ({ version: 1, id: 'r1', token: TOKEN, op, payload, ...extra });
const createPayload = (n = 1, extra = {}) => ({ prompt: 'hello', engine: 'codex', mode: 'browser', client_id: 'c', request_id: `q${n}`, ...extra });

// Sends chunks (optionally delayed), optionally half-closes, and collects everything until close.
function exchange(socketPath, chunks, { halfClose = true, delay = 0, keepOpenMs } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath, { allowHalfOpen: true });
    const parts = [];
    socket.on('data', (d) => parts.push(d));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(parts)));
    socket.on('connect', async () => {
      for (const chunk of chunks) {
        socket.write(chunk);
        if (delay) await new Promise((r) => setTimeout(r, delay));
      }
      if (halfClose) socket.end();
      if (keepOpenMs) setTimeout(() => socket.destroy(), keepOpenMs);
    });
  });
}

function decode(buf) {
  assert.ok(buf.length >= 4, 'response frame header');
  const length = buf.readUInt32BE(0);
  assert.equal(buf.length, 4 + length, 'exactly one response frame');
  return JSON.parse(buf.subarray(4).toString('utf8'));
}

async function setup(t, opts = {}) {
  const work = mkdtempSync(path.join(ROOT, '.ipc-test-'));
  const engine = new FakeEngine();
  const service = new SessionService({ store: new Store(path.join(work, 's.db'), HOST), engines: { codex: engine } });
  const ctx = { service, engine, work, socketPath: null, close: async () => {} };
  const params = { service, token: TOKEN, hostId: HOST, ...opts };
  t.after(async () => {
    await ctx.close();
    await service.close();
    process.chdir(ROOT);
    rmSync(work, { recursive: true, force: true });
  });
  if (SHORT_DIR) {
    const server = await startIpcServer({ ...params, baseDir: SHORT_DIR });
    ctx.socketPath = server.socketPath;
    ctx.server = server;
    ctx.close = () => server.close();
  } else {
    // Relative path keeps the sockaddr short; node:test runs each file in its own process.
    process.chdir(work);
    const server = net.createServer({ allowHalfOpen: true }, (s) => attachIpcConnection(s, params));
    await new Promise((resolve) => server.listen('i.sock', resolve));
    ctx.socketPath = 'i.sock';
    ctx.close = () => new Promise((resolve) => server.close(resolve));
  }
  return ctx;
}

const ask = async (ctx, obj, opts) => decode(await exchange(ctx.socketPath, [frame(obj)], opts));
const closingLeftovers = () => readdirSync(SHORT_DIR).filter((n) => n.startsWith('.mybrowse-closing-'));
const sessionCount = (ctx) => ctx.service.list().length;

test('health, fragmented frame and half-close', async (t) => {
  const ctx = await setup(t);
  const whole = frame(req('health'));
  const pieces = [whole.subarray(0, 2), whole.subarray(2, 5), whole.subarray(5, 20), whole.subarray(20)];
  const res = decode(await exchange(ctx.socketPath, pieces, { delay: 10 }));
  assert.equal(res.ok, true);
  assert.equal(res.id, 'r1');
  assert.equal(res.data.host, HOST);
  assert.equal(res.data.capabilities.browser, false);
});

test('nothing is dispatched before the client half-closes', async (t) => {
  const ctx = await setup(t);
  const socket = net.connect(ctx.socketPath, { allowHalfOpen: true });
  await new Promise((r) => socket.on('connect', r));
  socket.write(frame(req('create', createPayload())));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(sessionCount(ctx), 0);
  const parts = [];
  socket.on('data', (d) => parts.push(d));
  const closed = new Promise((r) => socket.on('close', r));
  socket.end();
  await closed;
  assert.equal(decode(Buffer.concat(parts)).ok, true);
  assert.equal(sessionCount(ctx), 1);
});

test('browser create returns waiting_user and never starts the engine', async (t) => {
  const ctx = await setup(t);
  const res = await ask(ctx, req('create', createPayload()));
  assert.equal(res.ok, true);
  assert.equal(res.data.session.status, 'waiting_user');
  assert.equal(ctx.engine.calls.length, 0);
  const got = await ask(ctx, req('get', { id: res.data.session.id }));
  assert.equal(got.data.session.id, res.data.session.id);
  const list = await ask(ctx, req('list'));
  assert.equal(list.data.sessions.length, 1);
});

test('extra frame rejects the first request without running it', async (t) => {
  const ctx = await setup(t);
  const two = Buffer.concat([frame(req('create', createPayload())), frame(req('health'))]);
  const res = decode(await exchange(ctx.socketPath, [two]));
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'invalid_frame');
  const trailing = Buffer.concat([frame(req('create', createPayload(2))), Buffer.from([0])]);
  assert.equal(decode(await exchange(ctx.socketPath, [trailing])).ok, false);
  assert.equal(sessionCount(ctx), 0);
});

test('invalid frames, JSON, UTF-8 and size limits are rejected', async (t) => {
  const ctx = await setup(t);
  const zero = Buffer.alloc(4);
  assert.equal(decode(await exchange(ctx.socketPath, [zero])).error.code, 'invalid_frame');
  assert.equal(decode(await exchange(ctx.socketPath, [frame('{nope')])).error.code, 'invalid_json');
  const badUtf8 = Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from([0xc3, 0x28, 0x7d])]);
  assert.equal(decode(await exchange(ctx.socketPath, [badUtf8])).error.code, 'invalid_utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(MAX_FRAME_BYTES + 1);
  // Over-limit header is refused without waiting for the body.
  const tooBig = decode(await exchange(ctx.socketPath, [head], { halfClose: false, keepOpenMs: 500 }));
  assert.equal(tooBig.error.code, 'frame_too_large');
  assert.equal(decode(await exchange(ctx.socketPath, [Buffer.from([0, 0])])).error.code, 'invalid_frame');
  const truncated = frame(req('health')).subarray(0, 10);
  assert.equal(decode(await exchange(ctx.socketPath, [truncated])).error.code, 'invalid_frame');
  // Non-ASCII text survives a round trip.
  const ok = await ask(ctx, req('create', createPayload(1, { prompt: '안녕 🌏 한글 요청' })));
  assert.equal(ok.data.session.prompt, '안녕 🌏 한글 요청');
});

test('wrong tokens and malformed requests never reach the service', async (t) => {
  const ctx = await setup(t);
  const wrong = await ask(ctx, req('create', createPayload(), { token: 'nope' }));
  assert.equal(wrong.error.code, 'unauthorized');
  assert.equal(wrong.error.status, 401);
  assert.ok(!JSON.stringify(wrong).includes(TOKEN));
  assert.equal((await ask(ctx, req('create', createPayload(), { token: 5 }))).error.code, 'invalid_request');
  const cases = [
    req('create', createPayload(), { extra: 1 }),
    req('create', createPayload(1, { surprise: true })),
    req('create', createPayload(1, { prompt: 7 })),
    req('create', { prompt: 'x', engine: 'codex' }),
    req('create', createPayload(), { version: 2 }),
    req('create', createPayload(), { id: 'bad id!' }),
    req('create', createPayload(), { op: 'shell' }),
    req('create', []),
    req('health', { x: 1 }),
    req('events', { id: 's', after_seq: -1 }),
    req('events', { id: 's', after_seq: 1.5 }),
    req('events', { id: 's', after_seq: Number.MAX_SAFE_INTEGER + 2 }),
    req('events', { id: 's', after_seq: 0, limit: 0 }),
    req('events', { id: 's', after_seq: 0, limit: 201 }),
    req('events', { id: 's', after_seq: 0, extra: 1 }),
    req('command', { id: 's', action: 'steer', text: 'x', request_id: 'a' }),
    req('command', { id: 's', action: 'steer', text: 3, expected_revision: 0, request_id: 'a' }),
  ];
  for (const bodyObj of cases) {
    const res = await ask(ctx, bodyObj);
    assert.equal(res.ok, false, JSON.stringify(bodyObj));
    assert.equal(res.error.status, 400);
  }
  assert.equal(sessionCount(ctx), 0);
  assert.equal(ctx.engine.calls.length, 0);
});

test('host mismatch is 409 and does not create a session', async (t) => {
  const ctx = await setup(t);
  const res = await ask(ctx, req('create', createPayload(1, { host: 'other' })));
  assert.equal(res.error.status, 409);
  assert.equal(res.error.code, 'host_mismatch');
  assert.equal(sessionCount(ctx), 0);
});

test('replayed create is idempotent and a changed command request_id payload is 409', async (t) => {
  const ctx = await setup(t);
  const a = await ask(ctx, req('create', createPayload(1)));
  const b = await ask(ctx, req('create', createPayload(1)));
  assert.equal(a.data.session.id, b.data.session.id);
  assert.equal(sessionCount(ctx), 1);
  const conflict = await ask(ctx, req('create', createPayload(1, { prompt: 'different' })));
  assert.equal(conflict.error.status, 409);
  assert.equal(conflict.error.code, 'request_conflict');

  // queue needs a running turn, so use a chat session whose fake engine has started.
  const chat = await ask(ctx, req('create', createPayload(2, { mode: 'chat' })));
  assert.equal(chat.data.session.status, 'running');
  assert.equal(ctx.engine.calls.length, 1);
  const id = chat.data.session.id;
  const rev = chat.data.session.revision;
  const first = await ask(ctx, req('command', { id, action: 'queue', text: 'one', expected_revision: rev, request_id: 'cmd1' }));
  assert.equal(first.ok, true);
  assert.equal(first.data.session.queue.length, 1);
  const same = await ask(ctx, req('command', { id, action: 'queue', text: 'one', expected_revision: rev, request_id: 'cmd1' }));
  assert.equal(same.ok, true);
  assert.equal(same.data.session.queue.length, 1, 'replay must not queue twice');
  const diff = await ask(ctx, req('command', { id, action: 'queue', text: 'two', expected_revision: rev, request_id: 'cmd1' }));
  assert.equal(diff.error.status, 409);
  assert.equal(diff.error.code, 'request_conflict');
  const missing = await ask(ctx, req('get', { id: 'nope' }));
  assert.equal(missing.error.status, 404);
});

test('event pages are finite, ordered and byte-bounded', async (t) => {
  const ctx = await setup(t);
  const created = await ask(ctx, req('create', createPayload()));
  const id = created.data.session.id;
  const base = ctx.service.events(id).length;
  for (let i = 0; i < 250; i++) ctx.service.store.appendEvent(id, 'tick', { i });
  const total = base + 250;

  const seen = [];
  let after = 0;
  let pages = 0;
  for (;;) {
    const res = await ask(ctx, req('events', { id, after_seq: after }));
    assert.equal(res.ok, true);
    assert.ok(res.data.events.length <= 100);
    seen.push(...res.data.events.map((e) => e.seq));
    after = res.data.next_seq;
    pages += 1;
    if (!res.data.has_more) break;
  }
  assert.equal(pages, Math.ceil(total / 100));
  assert.deepEqual(seen, Array.from({ length: total }, (_, i) => i + 1));
  const empty = await ask(ctx, req('events', { id, after_seq: total + 5 }));
  assert.deepEqual(empty.data, { events: [], next_seq: total + 5, has_more: false });
  const small = await ask(ctx, req('events', { id, after_seq: 0, limit: 3 }));
  assert.equal(small.data.events.length, 3);
  assert.equal(small.data.has_more, true);
  // The service API without a limit still replays everything.
  assert.equal(ctx.service.events(id, 0).length, total);

  const bigData = 'x'.repeat(450 * 1024);
  const startBig = total;
  for (let i = 0; i < 4; i++) ctx.service.store.appendEvent(id, 'big', { blob: bigData });
  const page = await ask(ctx, req('events', { id, after_seq: startBig }));
  assert.equal(page.ok, true);
  assert.equal(page.data.events.length, 2);
  assert.equal(page.data.has_more, true);
  assert.equal(page.data.next_seq, startBig + 2);

  const lastSeq = startBig + 4;
  ctx.service.store.appendEvent(id, 'huge', { blob: 'y'.repeat(MAX_FRAME_BYTES) });
  const huge = await ask(ctx, req('events', { id, after_seq: lastSeq }));
  assert.equal(huge.ok, false);
  assert.equal(huge.error.code, 'event_too_large');
});

test('list pages are finite, ordered, summary-only and cover 200+ sessions once', async (t) => {
  const ctx = await setup(t);
  const bigPrompt = 'k'.repeat(400 * 1024);
  const total = 230;
  const ids = [];
  for (let i = 0; i < total; i++) {
    const prompt = i === 0 ? bigPrompt : `task ${i} ${'가'.repeat(i % 3 === 0 ? 300 : 3)}`;
    ids.push(ctx.service.store.create({ prompt, engine: 'codex', mode: 'browser', client_id: 'c', request_id: `l${i}` }).session.id);
  }
  ctx.service.store.update(ids[1], { result: { blob: 'r'.repeat(2 * MAX_FRAME_BYTES) } });
  ctx.service.store.update(ids[2], { queue: [{ text: 'q'.repeat(100000) }] });

  const seen = [];
  let before;
  let pages = 0;
  for (;;) {
    const res = await ask(ctx, req('list', before === undefined ? {} : { before_rowid: before }));
    assert.equal(res.ok, true, JSON.stringify(res.error));
    assert.ok(res.data.sessions.length <= 100);
    for (const row of res.data.sessions) {
      assert.deepEqual(Object.keys(row).sort(), ['created_at', 'engine', 'host', 'id', 'mode', 'revision', 'status', 'title', 'updated_at']);
      assert.ok([...row.title].length <= 240);
      seen.push(row.id);
    }
    pages += 1;
    if (!res.data.has_more) break;
    before = res.data.next_before_rowid;
  }
  assert.equal(pages, 3);
  assert.equal(new Set(seen).size, total);
  assert.deepEqual(seen, [...ids].reverse(), 'newest first, nothing missing or repeated');
  const first = await ask(ctx, req('list', { limit: 5 }));
  assert.equal(first.data.sessions.length, 5);
  assert.equal(first.data.has_more, true);
  const last = ctx.service.store.db.prepare('SELECT rowid AS r FROM sessions WHERE id = ?').get(ids[0]).r;
  const tail = await ask(ctx, req('list', { before_rowid: last }));
  assert.deepEqual(tail.data, { sessions: [], next_before_rowid: null, has_more: false });
  // HTTP-facing list() is unchanged.
  assert.equal(ctx.service.list().length, total);
  // The big prompt is only reachable through get, which is bounded separately.
  const big = await ask(ctx, req('get', { id: ids[1] }));
  assert.equal(big.error.code, 'response_too_large');
  const huge = await ask(ctx, req('get', { id: ids[0] }));
  assert.equal(huge.ok, true);
});

test('list rejects invalid cursors and limits', async (t) => {
  const ctx = await setup(t);
  const cases = [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: '5' }, { before_rowid: 0 }, { before_rowid: -3 }, { before_rowid: 2.5 },
    { before_rowid: Number.MAX_SAFE_INTEGER + 2 }, { before_rowid: '9' }, { before_rowid: null }, { extra: 1 }];
  for (const payload of cases) {
    const res = await ask(ctx, req('list', payload));
    assert.equal(res.error?.status, 400, JSON.stringify(payload));
  }
});

test('internal failures are masked', async (t) => {
  const ctx = await setup(t);
  ctx.service.listSummaries = () => {
    throw new Error(`boom ${TOKEN} /Users/secret/path`);
  };
  const raw = await exchange(ctx.socketPath, [frame(req('list'))]);
  const res = decode(raw);
  assert.equal(res.error.code, 'internal_error');
  assert.equal(res.error.status, 500);
  assert.ok(!raw.toString().includes('boom'));
  assert.ok(!raw.toString().includes('/Users'));
  assert.ok(!raw.toString().includes('stack'));
});

test('receive timeout answers request_timeout and runs nothing', async (t) => {
  const ctx = await setup(t, { receiveTimeoutMs: 150 });
  const whole = frame(req('create', createPayload()));
  const res = decode(await exchange(ctx.socketPath, [whole.subarray(0, 12)], { halfClose: false, keepOpenMs: 2500 }));
  assert.equal(res.error.code, 'request_timeout');
  assert.equal(sessionCount(ctx), 0);
});

test('unserializable results become internal_error and the connection closes', async (t) => {
  const ctx = await setup(t);
  const cyclic = {};
  cyclic.self = cyclic;
  for (const value of [cyclic, { n: 10n }]) {
    ctx.service.listSummaries = () => value;
    const raw = await exchange(ctx.socketPath, [frame(req('list'))]); // resolves only when the server closes
    const res = decode(raw);
    assert.equal(res.error.code, 'internal_error');
    assert.equal(res.id, 'r1');
  }
});

test('client disconnect does not cancel an in-flight command', async (t) => {
  const ctx = await setup(t);
  let started;
  const startedPromise = new Promise((r) => (started = r));
  let release;
  const gate = new Promise((r) => (release = r));
  const state = { done: false, aborted: false };
  ctx.service.command = async () => {
    started();
    await gate;
    state.done = true;
    return { id: 's1' };
  };
  const socket = net.connect(ctx.socketPath, { allowHalfOpen: true });
  socket.on('error', () => {});
  await new Promise((r) => socket.on('connect', r));
  socket.end(frame(req('command', { id: 's1', action: 'stop', expected_revision: 0, request_id: 'stop1' })));
  await startedPromise;
  socket.destroy();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(state.done, false);
  release();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(state.done, true);
  // The transport is unaffected by the dead client: the server still answers.
  assert.equal((await ask(ctx, req('health'))).ok, true);
});

test('startIpcServer rejects unsafe baseDirs without touching the filesystem', async (t) => {
  const work = mkdtempSync(path.join(ROOT, '.ipc-test-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const service = { capabilities: () => ({}) };
  const params = { service, token: TOKEN, hostId: HOST };
  const file = path.join(work, 'f');
  writeFileSync(file, '');
  await assert.rejects(startIpcServer({ ...params, baseDir: file }), /directory/);
  await assert.rejects(startIpcServer({ ...params, baseDir: path.join(work, 'missing') }), /exist/);
  const real = path.join(work, 'real');
  mkdirSync(real);
  const link = path.join(work, 'link');
  symlinkSync(real, link);
  await assert.rejects(startIpcServer({ ...params, baseDir: link }), /symbolic link/);
  await assert.rejects(startIpcServer({ ...params, baseDir: real }), /bytes/);
  assert.deepEqual(existsSync(path.join(real, 'x')), false);
});

test('startIpcServer socket, permissions, limits and cleanup', { skip: NO_SHORT }, async (t) => {
  const service = new SessionService({ store: new Store(':memory:', HOST), engines: { codex: new FakeEngine() } });
  t.after(() => service.close());
  const server = await startIpcServer({ service, token: TOKEN, hostId: HOST, baseDir: SHORT_DIR, maxConnections: 2, receiveTimeoutMs: 5000 });
  t.after(() => server.close());
  const dir = path.dirname(server.socketPath);
  assert.ok(Buffer.byteLength(server.socketPath) <= 103);
  assert.equal(lstatSync(dir).mode & 0o777, 0o700);
  assert.equal(lstatSync(server.socketPath).mode & 0o777, 0o600);
  assert.ok(lstatSync(server.socketPath).isSocket());

  const hold = [net.connect(server.socketPath, { allowHalfOpen: true }), net.connect(server.socketPath, { allowHalfOpen: true })];
  await Promise.all(hold.map((s) => new Promise((r) => s.on('connect', r))));
  // Over the cap the connection is refused: closed with no response and no service work.
  const over = await exchange(server.socketPath, [frame(req('create', createPayload()))]).catch((err) => err);
  assert.ok(over instanceof Error ? ['ECONNRESET', 'EPIPE'].includes(over.code) : over.length === 0);
  assert.equal(service.list().length, 0);
  const released = Promise.all(hold.map(s => new Promise(r => s.once('close', r))));
  for (const s of hold) s.destroy();
  await released;
  await new Promise(r => setTimeout(r, 20));
  assert.equal((await exchange(server.socketPath, [frame(req('health'))])).length > 4, true, 'slots are released');

  await server.close();
  await server.close();
  assert.equal(existsSync(dir), false);
  assert.equal(service.list().length, 0); // close() must not close the service
  assert.deepEqual(closingLeftovers(), []);
});

async function startPlain(t) {
  const service = new SessionService({ store: new Store(':memory:', HOST), engines: { codex: new FakeEngine() } });
  t.after(() => service.close());
  const server = await startIpcServer({ service, token: TOKEN, hostId: HOST, baseDir: SHORT_DIR });
  return { server, dir: path.dirname(server.socketPath) };
}

test('close keeps a foreign file in the private directory', { skip: NO_SHORT }, async (t) => {
  const { server, dir } = await startPlain(t);
  const foreign = path.join(dir, 'foreign.txt');
  writeFileSync(foreign, 'keep');
  await server.close();
  assert.equal(existsSync(server.socketPath), false);
  assert.equal(readFileSync(foreign, 'utf8'), 'keep');
  assert.deepEqual(closingLeftovers(), []);
  rmSync(dir, { recursive: true, force: true });
});

// net.Server.close() would unlink a foreign file at the socket path; the daemon must prevent that.
test('close preserves a regular file that replaced the socket path', { skip: NO_SHORT }, async (t) => {
  const { server, dir } = await startPlain(t);
  unlinkSync(server.socketPath);
  writeFileSync(server.socketPath, 'foreign');
  await server.close();
  assert.equal(readFileSync(server.socketPath, 'utf8'), 'foreign');
  assert.deepEqual(closingLeftovers(), []);
  rmSync(dir, { recursive: true, force: true });
});

test('close preserves a different socket that replaced the socket path', { skip: NO_SHORT }, async (t) => {
  const { server, dir } = await startPlain(t);
  unlinkSync(server.socketPath);
  const other = net.createServer();
  await new Promise((resolve) => other.listen(server.socketPath, resolve));
  const ino = lstatSync(server.socketPath).ino;
  await server.close();
  const after = lstatSync(server.socketPath);
  assert.ok(after.isSocket());
  assert.equal(after.ino, ino);
  await new Promise((resolve) => other.close(resolve)); // removes its own file
  rmSync(dir, { recursive: true, force: true });
});

test('close refuses to touch a replaced directory', { skip: NO_SHORT }, async (t) => {
  const { server, dir } = await startPlain(t);
  const aside = `${dir}-aside`;
  renameSync(dir, aside);
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(server.socketPath, 'foreign');
  await assert.rejects(server.close(), /untouched/);
  assert.equal(readFileSync(server.socketPath, 'utf8'), 'foreign');
  assert.equal(existsSync(path.join(aside, 'daemon.sock')), true);
  assert.deepEqual(closingLeftovers(), []);
  rmSync(dir, { recursive: true, force: true });
  rmSync(aside, { recursive: true, force: true });
});
