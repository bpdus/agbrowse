// Session service: owns engine runs. HTTP clients only submit work and read state, so a client
// disconnect never stops an engine.
import { Broker } from './broker.mjs';
import { StoreError, hashPayload } from './store.mjs';

export class ServiceError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ServiceError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const MODES = new Set(['chat', 'browser']);
const ACTIONS = new Set(['steer', 'queue', 'stop', 'resume']);
const END_STATUSES = new Set(['done', 'failed', 'paused', 'uncertain']);
const RESUMABLE = new Set(['paused', 'done', 'waiting_user']);

function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ServiceError(400, 'invalid_request', `${name} must be a non-empty string`);
  }
}

function fromStoreError(err) {
  if (!(err instanceof StoreError)) return err;
  if (err.code === 'not_found') return new ServiceError(404, 'not_found', err.message);
  if (err.code === 'host_mismatch') return new ServiceError(409, 'host_mismatch', err.message);
  if (err.code === 'request_conflict') return new ServiceError(409, 'request_conflict', err.message, err.details);
  if (err.code === 'stale_revision') return new ServiceError(409, 'stale_revision', err.message, err.details);
  return err;
}

const errorText = (err) => String(err?.message ?? err);

export class SessionService {
  #listeners = new Map();
  #runs = new Map();
  #pendingCommands = new Map();
  #closed = false;

  constructor({ store, engines, broker, browserReady = false } = {}) {
    if (!store) throw new TypeError('store is required');
    this.store = store;
    this.engines = { ...(engines ?? {}) };
    this.broker = broker ?? new Broker();
    this.browserReady = browserReady === true;
  }

  get hostId() {
    return this.store.hostId;
  }

  capabilities() {
    return {
      engines: Object.keys(this.engines),
      modes: [...MODES],
      browser: this.browserReady,
      opencodex: false,
      queue_boundary: 'turn_end',
      steer: 'per_engine',
    };
  }

  create(input = {}) {
    this.#assertOpen();
    const { prompt, engine, client_id, request_id, host } = input ?? {};
    const mode = input?.mode ?? 'chat';
    requireString(client_id, 'client_id');
    requireString(request_id, 'request_id');
    requireString(prompt, 'prompt');
    if (host !== undefined && host !== this.hostId) {
      throw new ServiceError(409, 'host_mismatch', `this daemon serves host ${this.hostId}`);
    }
    if (typeof engine !== 'string' || !Object.hasOwn(this.engines, engine)) {
      throw new ServiceError(400, 'unsupported_engine', `engine must be one of ${Object.keys(this.engines).join(', ')}`);
    }
    if (!MODES.has(mode)) throw new ServiceError(400, 'unsupported_mode', 'mode must be chat or browser');

    let created;
    try {
      created = this.store.create({ prompt, engine, mode, client_id, request_id });
    } catch (err) {
      throw fromStoreError(err);
    }
    if (!created.created) return created.session;

    const id = created.session.id;
    this.#emit(id, 'created', { engine, mode });
    if (mode === 'browser' && !this.browserReady) {
      this.store.update(id, { status: 'waiting_user' });
      this.#emit(id, 'browser_not_integrated', {
        reason: 'The MyBrowse Chromium tool bridge is not connected; browser sessions cannot run.',
      });
      return this.store.get(id);
    }
    this.#startTurn(id, prompt);
    return this.store.get(id);
  }

  list() {
    return this.store.list();
  }

  listSummaries(beforeRowid, limit) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new ServiceError(400, 'invalid_request', 'limit must be a positive integer');
    }
    if (beforeRowid != null && (!Number.isSafeInteger(beforeRowid) || beforeRowid < 1)) {
      throw new ServiceError(400, 'invalid_request', 'before_rowid must be a positive safe integer');
    }
    return this.store.listSummaries(beforeRowid, limit);
  }

  get(id) {
    const session = this.store.get(id);
    if (!session) throw new ServiceError(404, 'not_found', `session ${id} not found`);
    return session;
  }

  events(id, afterSeq = 0, limit) {
    this.get(id);
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      throw new ServiceError(400, 'invalid_request', 'afterSeq must be a non-negative integer');
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new ServiceError(400, 'invalid_request', 'limit must be a positive integer');
    }
    return this.store.events(id, afterSeq, limit);
  }

  subscribe(id, listener) {
    this.get(id);
    let set = this.#listeners.get(id);
    if (!set) this.#listeners.set(id, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.#listeners.get(id) === set) this.#listeners.delete(id);
    };
  }

  async command(id, input = {}) {
    this.#assertOpen();
    const { action, text, expected_revision, request_id } = input ?? {};
    requireString(request_id, 'request_id');
    if (!Number.isInteger(expected_revision)) {
      throw new ServiceError(400, 'invalid_request', 'expected_revision must be an integer');
    }
    if (!ACTIONS.has(action)) throw new ServiceError(400, 'invalid_request', 'action must be steer, queue, stop or resume');
    if (action !== 'stop') requireString(text, 'text');
    else if (text !== undefined && typeof text !== 'string') {
      throw new ServiceError(400, 'invalid_request', 'text must be a string');
    }
    this.get(id);

    const hash = hashPayload({ action, text: text ?? null, expected_revision });
    const key = `${id}\u0000${request_id}`;
    const pending = this.#pendingCommands.get(key);
    const prior = this.store.getCommand(id, request_id);
    if ((prior && prior.payload_hash !== hash) || (pending && pending.hash !== hash)) {
      throw new ServiceError(409, 'request_conflict', 'request_id was already used with a different command');
    }
    // A replayed command is answered with current state and never executed twice.
    if (pending) {
      await pending.promise;
      return this.get(id);
    }
    if (prior) return this.get(id);

    const promise = this.#execute(id, { action, text, expected_revision, request_id, hash });
    this.#pendingCommands.set(key, { hash, promise });
    try {
      return await promise;
    } finally {
      this.#pendingCommands.delete(key);
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const stops = [];
    for (const [id, run] of this.#runs) {
      if (run.ended) continue;
      this.broker.block(id);
      run.stopped = true;
      run.controller.abort();
      run.ended = true;
      const status = this.broker.hasInflightMutation(id) ? 'uncertain' : 'paused';
      this.store.update(id, { status });
      this.#emit(id, 'daemon_stopped', { status });
      stops.push(run.stopHandle());
    }
    await Promise.allSettled(stops);
    this.#listeners.clear();
    this.store.close();
  }

  #assertOpen() {
    if (this.#closed) throw new ServiceError(503, 'closed', 'service is closed');
  }

  #emit(id, type, data) {
    const event = this.store.appendEvent(id, type, data);
    for (const listener of [...(this.#listeners.get(id) ?? [])]) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must not affect the session.
      }
    }
    return event;
  }

  #activeRun(id) {
    const run = this.#runs.get(id);
    return run && !run.ended ? run : null;
  }

  async #execute(id, { action, text, expected_revision, request_id, hash }) {
    // Every check below is synchronous until the state change is written, so two commands cannot
    // both pass the revision check.
    const session = this.get(id);
    if (session.revision !== expected_revision) {
      throw new ServiceError(409, 'stale_revision', 'expected_revision does not match', { revision: session.revision });
    }
    const run = this.#activeRun(id);
    const commit = (patch, eventType, eventData) => {
      const updated = this.store.update(id, patch, { expectedRevision: expected_revision });
      this.store.recordCommand(id, request_id, hash);
      this.#emit(id, eventType, { ...eventData, request_id, revision: updated.revision });
      return updated;
    };

    if (action === 'steer') {
      if (!run) throw new ServiceError(409, 'not_running', 'no running turn to steer');
      if (!run.handle) throw new ServiceError(409, 'engine_starting', 'engine has not finished starting');
      if (typeof run.handle.steer !== 'function') {
        throw new ServiceError(409, 'unsupported', `engine ${session.engine} does not support steer; use queue or stop`);
      }
      commit({}, 'steer', { text });
      try {
        await run.handle.steer(text);
      } catch (err) {
        this.#emit(id, 'steer_failed', { request_id, error: errorText(err) });
        throw new ServiceError(502, 'steer_failed', errorText(err));
      }
      return this.get(id);
    }

    if (action === 'queue') {
      if (!run) throw new ServiceError(409, 'not_running', 'queue needs a running turn; use resume');
      const queue = [...session.queue, { text, request_id, created_at: new Date().toISOString() }];
      commit({ queue }, 'queued', { text, position: queue.length });
      return this.get(id);
    }

    if (action === 'stop') {
      if (!run) throw new ServiceError(409, 'not_running', 'session has no running turn');
      // Block new tool calls first, then stop the engine.
      this.broker.block(id);
      run.stopped = true;
      run.controller.abort();
      run.ended = true;
      const status = this.broker.hasInflightMutation(id) ? 'uncertain' : 'paused';
      commit({ status }, 'stop_requested', { status, engine_started: Boolean(run.handle) });
      {
        try {
          await run.stopHandle();
          this.#emit(id, 'stopped', {});
        } catch (err) {
          this.#emit(id, 'stop_error', { error: errorText(err) });
        }
      }
      // Without a handle the start is still pending; #startTurn stops the handle when it arrives.
      return this.get(id);
    }

    // resume
    if (run) throw new ServiceError(409, 'invalid_state', 'session is already running');
    if (!RESUMABLE.has(session.status)) {
      throw new ServiceError(409, 'invalid_state', `cannot resume a ${session.status} session`);
    }
    if (session.mode === 'browser' && !this.browserReady) {
      throw new ServiceError(409, 'browser_not_integrated', 'browser sessions cannot run until the tool bridge is connected');
    }
    commit({}, 'resume', { text });
    this.broker.allow(id);
    this.#startTurn(id, text);
    return this.get(id);
  }

  // Starts one engine turn. session.prompt holds this turn's text; session.task keeps the original.
  #startTurn(id, text) {
    const session = this.store.get(id);
    const engine = this.engines[session.engine];
    const run = { stopped: false, ended: false, handle: null, stopOnArrival: false, controller: new AbortController() };
    run.stopHandle=()=>run.stopPromise ||= (async()=>{const handle=run.handle || await run.starting;await handle?.stop?.();})();
    this.#runs.set(id, run);
    this.store.update(id, { status: 'running', prompt: text });
    this.#emit(id, 'turn_started', { prompt: text, engine_session_id: session.engine_session_id });

    const owns = () => !this.#closed && !run.ended && this.#runs.get(id) === run;
    const callbacks = {
      signal: run.controller.signal,
      onEvent: (type, data) => {
        if (!owns() || typeof type !== 'string' || !type) return;
        this.#emit(id, `engine.${type}`, data ?? null);
      },
      onId: (engineSessionId) => {
        if (!owns() || typeof engineSessionId !== 'string' || !engineSessionId) return;
        if (this.store.get(id).engine_session_id === engineSessionId) return;
        this.store.update(id, { engine_session_id: engineSessionId }, { bump: false });
        this.#emit(id, 'engine_session', { engine_session_id: engineSessionId });
      },
      onWaiting: (reason) => {
        if (!owns()) return;
        this.#finishRun(id, run, 'waiting_user', undefined, { reason: reason ?? null });
        run.stopOnArrival = true;
        run.controller.abort();
        if (run.handle) void run.stopHandle().catch(() => {});
      },
      onEnd: (end) => {
        if (!owns()) return;
        const status = END_STATUSES.has(end?.status) ? end.status : 'uncertain';
        const finished = this.#finishRun(id, run, status, end?.result ?? null);
        if (finished === 'done') this.#deliverQueue(id);
      },
    };

    let starting;
    try {
      starting = Promise.resolve(engine.start(this.store.get(id), callbacks));
    } catch (err) {
      starting = Promise.reject(err);
    }
    run.starting=starting;
    starting.then(
      (handle) => {
        if (run.stopped || run.stopOnArrival) {
          // stop (or waiting) arrived before the engine did: never activate this engine.
          if (typeof handle?.stop === 'function') void run.stopHandle().catch(() => {});
          return;
        }
        if (!owns()) return;
        if (typeof handle?.stop !== 'function') {
          this.#finishRun(id, run, 'failed', { error: 'engine handle has no stop()' });
          return;
        }
        run.handle = handle;
      },
      (err) => {
        if (!owns()) return;
        this.#finishRun(id, run, 'failed', { error: errorText(err) });
        this.#emit(id, 'start_failed', { error: errorText(err) });
      },
    );
  }

  // An in-flight mutation outranks whatever the engine reported.
  #finishRun(id, run, status, result, extra = {}) {
    run.ended = true;
    const final = this.broker.hasInflightMutation(id) ? 'uncertain' : status;
    const patch = { status: final };
    if (result !== undefined) patch.result = result;
    this.store.update(id, patch);
    this.#emit(id, 'turn_ended', { status: final, reported: status, ...extra });
    return final;
  }

  // queue_boundary = turn_end: the next queued instruction starts a new turn on the same engine session.
  #deliverQueue(id) {
    const session = this.store.get(id);
    if (session.queue.length === 0 || this.#closed) return;
    const [next, ...rest] = session.queue;
    this.store.update(id, { queue: rest });
    this.#emit(id, 'queue_delivered', { text: next.text, request_id: next.request_id, remaining: rest.length });
    this.#startTurn(id, next.text);
  }
}
