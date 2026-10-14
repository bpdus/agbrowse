// Deterministic boundary checks with a fake engine. These do not verify real Codex/Claude behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Broker, isMutationTool } from '../src/broker.mjs';
import { SessionService, ServiceError } from '../src/service.mjs';

const HOST = 'imac';
const tick = () => new Promise((resolve) => setImmediate(resolve));

function tempDb(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mybrowse-core-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'sessions.db');
}

// Fake driver: records each start; the test drives callbacks and the start promise by hand.
class FakeEngine {
  constructor({ steer = false, deferStart = false, onStart } = {}) {
    this.steer = steer;
    this.deferStart = deferStart;
    this.onStart = onStart;
    this.calls = [];
  }
  start(session, cb) {
    const call = { session: structuredClone(session), cb, stops: 0, steers: [] };
    call.handle = { stop: async () => void call.stops++ };
    if (this.steer) call.handle.steer = async (text) => void call.steers.push(text);
    this.calls.push(call);
    this.onStart?.(call);
    if (!this.deferStart) return Promise.resolve(call.handle);
    return new Promise((resolve, reject) => {
      call.resolve = () => resolve(call.handle);
      call.reject = reject;
    });
  }
  get last() {
    return this.calls.at(-1);
  }
}

function setup(t, { engine = new FakeEngine(), broker = new Broker(), browserReady = false, dbPath } = {}) {
  const store = new Store(dbPath ?? tempDb(t), HOST);
  const service = new SessionService({ store, engines: { codex: engine, claude: new FakeEngine() }, broker, browserReady });
  t.after(() => service.close());
  return { store, service, engine, broker };
}

let counter = 0;
const createInput = (extra = {}) => ({
  prompt: 'read the page title',
  engine: 'codex',
  mode: 'chat',
  client_id: 'muse',
  request_id: `req-${++counter}`,
  ...extra,
});

async function rejectsWith(promiseOrFn, status, code) {
  await assert.rejects(
    async () => (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn),
    (err) => err instanceof ServiceError && err.status === status && err.code === code,
  );
}

const cmd = (service, id, action, extra = {}) =>
  service.command(id, {
    action,
    expected_revision: service.get(id).revision,
    request_id: `cmd-${++counter}`,
    ...extra,
  });

test('store restart turns running sessions into uncertain and never restarts them', async (t) => {
  const dbPath = tempDb(t);
  const first = new Store(dbPath, HOST);
  const { session } = first.create({ ...createInput(), status: 'queued' });
  const running = first.update(session.id, { status: 'running' });
  const done = first.create(createInput()).session;
  first.update(done.id, { status: 'done' });
  first.close();

  const engine = new FakeEngine();
  const { service } = setup(t, { engine, dbPath });
  const recovered = service.get(session.id);
  assert.equal(recovered.status, 'uncertain');
  assert.equal(recovered.revision, running.revision + 1);
  assert.equal(service.get(done.id).status, 'done');
  assert.deepEqual(
    service.events(session.id).map((e) => e.type),
    ['recovered_uncertain'],
  );
  assert.equal(engine.calls.length, 0, 'no engine started on restart');
  await rejectsWith(cmd(service, session.id, 'resume', { text: 'go' }), 409, 'invalid_state');
});

test('duplicate create returns the same session; same key with a different body conflicts', (t) => {
  const { service, engine } = setup(t);
  const input = createInput();
  const a = service.create(input);
  const b = service.create({ ...input });
  assert.equal(a.id, b.id);
  assert.equal(engine.calls.length, 1, 'duplicate create does not start a second engine');
  assert.throws(() => service.create({ ...input, prompt: 'something else' }), (e) => e.status === 409 && e.code === 'request_conflict');
  // Different client with the same request_id is a different key.
  const c = service.create({ ...input, client_id: 'ui' });
  assert.notEqual(c.id, a.id);
});

test('create validates engine, mode, host and identifiers', (t) => {
  const { service } = setup(t);
  assert.throws(() => service.create(createInput({ engine: 'opencodex' })), (e) => e.status === 400 && e.code === 'unsupported_engine');
  assert.throws(() => service.create(createInput({ mode: 'desktop' })), (e) => e.status === 400 && e.code === 'unsupported_mode');
  assert.throws(() => service.create(createInput({ host: 'macbook' })), (e) => e.status === 409 && e.code === 'host_mismatch');
  assert.throws(() => service.create(createInput({ request_id: '' })), (e) => e.status === 400);
  assert.throws(() => service.create(createInput({ client_id: 7 })), (e) => e.status === 400);
  assert.equal(service.list().length, 0);
});

test('browser mode without the tool bridge waits for the user and starts nothing', async (t) => {
  const { service, engine } = setup(t);
  const s = service.create(createInput({ mode: 'browser' }));
  assert.equal(s.status, 'waiting_user');
  assert.equal(engine.calls.length, 0);
  assert.deepEqual(service.events(s.id).map((e) => e.type), ['created', 'browser_not_integrated']);
  await rejectsWith(cmd(service, s.id, 'resume', { text: 'go' }), 409, 'browser_not_integrated');
  assert.equal(service.capabilities().browser, false);
  assert.equal(service.capabilities().queue_boundary, 'turn_end');
  assert.equal(service.capabilities().opencodex, false);
});

test('chat turn records the real engine session id, events and result', async (t) => {
  const { service, engine } = setup(t);
  const s = service.create(createInput());
  assert.equal(s.status, 'running');
  assert.equal(s.revision, 2);
  await tick();
  engine.last.cb.onId('thread-123');
  engine.last.cb.onEvent('assistant_delta', { text: 'Title' });
  const beforeEnd = service.get(s.id);
  assert.equal(beforeEnd.engine_session_id, 'thread-123');
  assert.equal(beforeEnd.revision, 2, 'engine id does not bump revision');
  engine.last.cb.onEnd({ status: 'done', result: { text: 'Example Domain' } });
  const after = service.get(s.id);
  assert.equal(after.status, 'done');
  assert.deepEqual(after.result, { text: 'Example Domain' });
  assert.equal(after.revision, 3);
  assert.deepEqual(
    service.events(s.id).map((e) => e.type),
    ['created', 'turn_started', 'engine_session', 'engine.assistant_delta', 'turn_ended'],
  );
});

test('unknown end status is recorded as uncertain', async (t) => {
  const { service, engine } = setup(t);
  const s = service.create(createInput());
  engine.last.cb.onEnd({ status: 'success' });
  assert.equal(service.get(s.id).status, 'uncertain');
});

test('command requires request_id and expected_revision, and rejects stale revisions', async (t) => {
  const { service } = setup(t, { engine: new FakeEngine({ steer: true }) });
  const s = service.create(createInput());
  await tick();
  await rejectsWith(service.command(s.id, { action: 'queue', text: 'x', expected_revision: s.revision }), 400, 'invalid_request');
  await rejectsWith(service.command(s.id, { action: 'queue', text: 'x', request_id: 'r' }), 400, 'invalid_request');
  await rejectsWith(service.command(s.id, { action: 'jump', text: 'x', request_id: 'r', expected_revision: s.revision }), 400, 'invalid_request');
  await rejectsWith(service.command('missing', { action: 'stop', request_id: 'r', expected_revision: 1 }), 404, 'not_found');
  await rejectsWith(
    service.command(s.id, { action: 'queue', text: 'x', request_id: 'r1', expected_revision: s.revision - 1 }),
    409,
    'stale_revision',
  );
  assert.equal(service.get(s.id).revision, s.revision);
});

test('replayed command is not executed twice; same request_id with a new body conflicts', async (t) => {
  const engine = new FakeEngine({ steer: true });
  const { service } = setup(t, { engine });
  const s = service.create(createInput());
  await tick();
  const body = { action: 'steer', text: 'prefer the h1', expected_revision: s.revision, request_id: 'steer-1' };
  const [first, second] = await Promise.all([service.command(s.id, body), service.command(s.id, { ...body })]);
  const third = await service.command(s.id, { ...body });
  assert.deepEqual(engine.last.steers, ['prefer the h1']);
  assert.equal(first.revision, s.revision + 1);
  assert.equal(second.revision, first.revision);
  assert.equal(third.revision, first.revision);
  await rejectsWith(service.command(s.id, { ...body, text: 'other' }), 409, 'request_conflict');
});

test('steer without engine support is 409 and does not change revision', async (t) => {
  const { service } = setup(t);
  const s = service.create(createInput());
  await tick();
  await rejectsWith(cmd(service, s.id, 'steer', { text: 'faster' }), 409, 'unsupported');
  assert.equal(service.get(s.id).revision, s.revision);
});

test('queue is delivered as a new turn after the current turn ends, in order', async (t) => {
  const engine = new FakeEngine();
  const { service } = setup(t, { engine });
  const s = service.create(createInput());
  await tick();
  engine.last.cb.onId('thread-9');
  await cmd(service, s.id, 'queue', { text: 'then read the first paragraph' });
  await cmd(service, s.id, 'queue', { text: 'then summarise' });
  assert.equal(engine.calls.length, 1, 'queue does not interrupt the running turn');
  assert.equal(service.get(s.id).queue.length, 2);

  engine.calls[0].cb.onEnd({ status: 'done', result: { n: 1 } });
  assert.equal(engine.calls.length, 2);
  assert.equal(engine.calls[1].session.prompt, 'then read the first paragraph');
  assert.equal(engine.calls[1].session.task, 'read the page title', 'original task is preserved');
  assert.equal(engine.calls[1].session.engine_session_id, 'thread-9');
  assert.equal(service.get(s.id).status, 'running');
  assert.equal(service.get(s.id).queue.length, 1);

  // Late callbacks from the finished first turn are ignored.
  engine.calls[0].cb.onEnd({ status: 'failed' });
  engine.calls[0].cb.onEvent('assistant_delta', { text: 'late' });
  assert.equal(service.get(s.id).status, 'running');

  engine.calls[1].cb.onEnd({ status: 'done' });
  assert.equal(engine.calls[2].session.prompt, 'then summarise');
  engine.calls[2].cb.onEnd({ status: 'done', result: { n: 3 } });
  const final = service.get(s.id);
  assert.equal(final.status, 'done');
  assert.deepEqual(final.queue, []);
  assert.ok(!service.events(s.id).some((e) => e.type === 'engine.assistant_delta'));
});

test('a failed turn keeps the queue and does not start the next instruction', async (t) => {
  const engine = new FakeEngine();
  const { service } = setup(t, { engine });
  const s = service.create(createInput());
  await tick();
  await cmd(service, s.id, 'queue', { text: 'next' });
  engine.last.cb.onEnd({ status: 'failed', result: { error: 'boom' } });
  assert.equal(engine.calls.length, 1);
  assert.equal(service.get(s.id).status, 'failed');
  assert.equal(service.get(s.id).queue.length, 1);
  await rejectsWith(cmd(service, s.id, 'resume', { text: 'retry' }), 409, 'invalid_state');
});

test('stop during start: no handle yet, the late handle is stopped and never activated', async (t) => {
  const engine = new FakeEngine({ deferStart: true });
  const broker = new Broker();
  const { service } = setup(t, { engine, broker });
  const s = service.create(createInput());
  await cmd(service, s.id, 'queue', { text: 'queued while starting' });
  const stopping = cmd(service, s.id, 'stop');
  assert.equal(service.get(s.id).status, 'paused');
  assert.ok(broker.isBlocked(s.id), 'broker is blocked before the engine is stopped');

  const call = engine.last;
  call.cb.onId('late-thread');
  call.cb.onEvent('assistant_delta', { text: 'late' });
  call.resolve();
  const stopped=await stopping;
  assert.equal(stopped.status,'paused');
  await tick();
  assert.equal(call.stops, 1, 'late handle is stopped');
  call.cb.onEnd({ status: 'done' });
  await tick();
  const after = service.get(s.id);
  assert.equal(after.status, 'paused');
  assert.equal(after.engine_session_id, null);
  assert.equal(engine.calls.length, 1, 'queue is not delivered after stop');
  await rejectsWith(cmd(service, s.id, 'steer', { text: 'x' }), 409, 'not_running');
});

test('stop with a live handle blocks the broker first, then stops the engine; late end is ignored', async (t) => {
  const order = [];
  const broker = new Broker();
  const block = broker.block.bind(broker);
  broker.block = (id) => {
    order.push('block');
    block(id);
  };
  const engine = new FakeEngine({
    onStart: (call) => {
      call.handle.stop = async () => void order.push('engine.stop');
    },
  });
  const { service } = setup(t, { engine, broker });
  const s = service.create(createInput());
  await tick();
  const res = await cmd(service, s.id, 'stop');
  assert.deepEqual(order, ['block', 'engine.stop']);
  assert.equal(res.status, 'paused');
  engine.last.cb.onEnd({ status: 'done', result: { text: 'late' } });
  assert.equal(service.get(s.id).status, 'paused');
  assert.equal(service.get(s.id).result, null);
  await rejectsWith(cmd(service, s.id, 'stop'), 409, 'not_running');
});

test('resume after stop starts a new turn with the stored engine session and unblocks the broker', async (t) => {
  const engine = new FakeEngine();
  const broker = new Broker();
  const { service } = setup(t, { engine, broker });
  const s = service.create(createInput());
  await tick();
  engine.last.cb.onId('thread-r');
  await cmd(service, s.id, 'stop');
  const resumed = await cmd(service, s.id, 'resume', { text: 'continue from the latest screen' });
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.prompt, 'continue from the latest screen');
  assert.equal(resumed.task, 'read the page title');
  assert.equal(engine.last.session.engine_session_id, 'thread-r');
  assert.equal(broker.isBlocked(s.id), false);
  await rejectsWith(cmd(service, s.id, 'resume', { text: 'again' }), 409, 'invalid_state');
});

test('waiting_user is not overwritten by a late completion', async (t) => {
  const engine = new FakeEngine();
  const { service } = setup(t, { engine });
  const s = service.create(createInput());
  await tick();
  engine.last.cb.onWaiting('codex login required');
  engine.last.cb.onEnd({ status: 'done', result: { text: 'late' } });
  await tick();
  const after = service.get(s.id);
  assert.equal(after.status, 'waiting_user');
  assert.equal(after.result, null);
  assert.equal(engine.last.stops, 1);
  const resumed = await cmd(service, s.id, 'resume', { text: 'logged in, continue' });
  assert.equal(resumed.status, 'running');
});

test('synchronous callbacks inside start are handled', async (t) => {
  const engine = new FakeEngine({
    onStart: (call) => {
      call.cb.onId('sync-thread');
      call.cb.onEnd({ status: 'done', result: { ok: true } });
    },
  });
  const { service } = setup(t, { engine });
  const s = service.create(createInput());
  await tick();
  const after = service.get(s.id);
  assert.equal(after.status, 'done');
  assert.equal(after.engine_session_id, 'sync-thread');
  assert.equal(engine.last.stops, 0);
});

test('start failures become failed: rejected promise, synchronous throw and missing stop()', async (t) => {
  const rejecting = new FakeEngine({ deferStart: true });
  const { service } = setup(t, { engine: rejecting });
  const a = service.create(createInput());
  rejecting.last.reject(new Error('codex not found'));
  await tick();
  assert.equal(service.get(a.id).status, 'failed');
  assert.ok(service.events(a.id).some((e) => e.type === 'start_failed'));

  const throwing = { start() { throw new Error('spawn EACCES'); } };
  const s2 = setup(t, { engine: throwing }).service;
  const b = s2.create(createInput());
  await tick();
  assert.equal(s2.get(b.id).status, 'failed');

  const noStop = { start: async () => ({}) };
  const s3 = setup(t, { engine: noStop }).service;
  const c = s3.create(createInput());
  await tick();
  assert.equal(s3.get(c.id).status, 'failed');
});

test('broker leases: overlapping control is refused; release frees the resource', () => {
  const broker = new Broker();
  broker.acquire('s1', { host: HOST, profile: 'default', tab: '1' });
  broker.acquire('s2', { host: HOST, profile: 'default', tab: '2' });
  assert.throws(() => broker.acquire('s3', { host: HOST, profile: 'default', tab: '1' }), { code: 'lease_conflict' });
  assert.throws(() => broker.acquire('s3', { host: HOST, profile: 'default' }), { code: 'lease_conflict' });
  broker.acquire('s3', { host: HOST, profile: 'work', tab: '1' });
  broker.acquire('s4', { host: 'macbook', profile: 'default', tab: '1' });
  broker.release('s1');
  broker.acquire('s5', { host: HOST, profile: 'default', tab: '1' });
  assert.throws(() => broker.acquire('s6', { profile: 'default' }), { code: 'invalid_resource' });
});

test('broker dispatch checks block, revision and lease before running the tool', async () => {
  const broker = new Broker();
  const resource = { host: HOST, profile: 'default', tab: '7' };
  let runs = 0;
  const run = async () => ++runs;
  const base = { sessionId: 's', resource, revision: 3, currentRevision: 3, tool: 'chrome_click', run };

  assert.equal((await broker.dispatch(base)).status, 'no_lease');
  broker.acquire('s', resource);
  assert.equal((await broker.dispatch({ ...base, resource: { ...resource, tab: '8' } })).status, 'no_lease');
  assert.equal((await broker.dispatch({ ...base, currentRevision: () => 4 })).status, 'stale');
  broker.block('s');
  assert.equal((await broker.dispatch(base)).status, 'blocked');
  assert.equal(runs, 0, 'refused calls never reach the tool');
  broker.allow('s');
  const ok = await broker.dispatch(base);
  assert.deepEqual([ok.status, ok.executed, ok.result], ['ok', true, 1]);
});

test('broker classifies mutations and reports a failed mutation as uncertain', async () => {
  assert.equal(isMutationTool('chrome_evaluate'), true);
  assert.equal(isMutationTool('some_new_tool'), true);
  assert.equal(isMutationTool('chrome_screenshot'), false);
  const broker = new Broker();
  const resource = { host: HOST, profile: 'default' };
  broker.acquire('s', resource);
  const fail = async () => {
    throw new Error('socket closed');
  };
  const mutation = await broker.dispatch({ sessionId: 's', resource, revision: 1, currentRevision: 1, tool: 'chrome_evaluate', run: fail });
  assert.deepEqual([mutation.status, mutation.executed], ['uncertain', 'unknown']);
  const observe = await broker.dispatch({ sessionId: 's', resource, revision: 1, currentRevision: 1, tool: 'chrome_screenshot', run: fail });
  assert.deepEqual([observe.status, observe.executed], ['failed', false]);
  assert.equal(broker.hasInflightMutation('s'), false);
});

test('an in-flight mutation makes engine completion and stop uncertain', async (t) => {
  const engine = new FakeEngine();
  const broker = new Broker();
  const { service } = setup(t, { engine, broker });
  const resource = { host: HOST, profile: 'default', tab: '1' };

  const a = service.create(createInput());
  await tick();
  broker.acquire(a.id, resource);
  let release;
  const pending = broker.dispatch({
    sessionId: a.id,
    resource,
    revision: 1,
    currentRevision: 1,
    tool: 'chrome_click',
    run: () => new Promise((resolve) => (release = resolve)),
  });
  await tick();
  assert.equal(broker.hasInflightMutation(a.id), true);
  engine.last.cb.onEnd({ status: 'done' });
  assert.equal(service.get(a.id).status, 'uncertain');
  release('clicked');
  await pending;
  broker.release(a.id);

  const b = service.create(createInput());
  await tick();
  broker.acquire(b.id, resource);
  const pendingB = broker.dispatch({
    sessionId: b.id,
    resource,
    revision: 1,
    currentRevision: 1,
    tool: 'chrome_type',
    run: () => new Promise((resolve) => (release = resolve)),
  });
  await tick();
  const stopped = await cmd(service, b.id, 'stop');
  assert.equal(stopped.status, 'uncertain');
  release('typed');
  await pendingB;
  // After stop the broker refuses new tools for that session.
  assert.equal(
    (await broker.dispatch({ sessionId: b.id, resource, revision: 1, currentRevision: 1, tool: 'chrome_click', run: async () => 1 })).status,
    'blocked',
  );
});

test('subscribe receives appended events; events(afterSeq) replays from the store', async (t) => {
  const engine = new FakeEngine();
  const { service } = setup(t, { engine });
  const s = service.create(createInput());
  const seen = [];
  const unsubscribe = service.subscribe(s.id, (e) => seen.push(e));
  engine.last.cb.onEvent('assistant_delta', { text: 'a' });
  unsubscribe();
  engine.last.cb.onEvent('assistant_delta', { text: 'b' });
  assert.deepEqual(seen.map((e) => e.data.text), ['a']);
  const all = service.events(s.id);
  assert.deepEqual(all.map((e) => e.seq), all.map((_, i) => i + 1));
  assert.deepEqual(service.events(s.id, 2).map((e) => e.seq), all.slice(2).map((e) => e.seq));
  assert.throws(() => service.subscribe('missing', () => {}), (e) => e.status === 404);
});

test('close stops running engines and leaves them paused, then refuses work', async (t) => {
  const engine = new FakeEngine();
  const dbPath = tempDb(t);
  const service = new SessionService({ store: new Store(dbPath, HOST), engines: { codex: engine } });
  const s = service.create(createInput());
  await tick();
  await service.close();
  assert.equal(engine.last.stops, 1);
  const reopened = new Store(dbPath, HOST);
  t.after(() => reopened.close());
  assert.equal(reopened.get(s.id).status, 'paused');
  assert.throws(() => service.create(createInput()), (e) => e.status === 503);
});
