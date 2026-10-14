import {EventEmitter} from 'node:events';

export const MAX_RECORD_BYTES = 2 * 1024 * 1024;

const decoder = () => new TextDecoder('utf-8', {fatal: true});

function rpcError(code, message, extra = {}) {
  return Object.assign(new Error(message), {code}, extra);
}

// Pi RPC over LF-delimited UTF-8 JSONL. Splitting happens on the raw 0x0A byte, so multi-byte
// characters cut across chunks are decoded only once the whole record has arrived.
// Emits: 'event' (any non-response record), 'protocolError' (fatal), 'closed' (once).
// Every request error carries `sent`: true when the command line was already written, so the
// caller can tell "never delivered" from "delivered, outcome unknown".
export class PiRpc extends EventEmitter {
  constructor(child, {timeout = 30000, maxRecordBytes = MAX_RECORD_BYTES} = {}) {
    super();
    Object.assign(this, {child, timeout, maxRecordBytes});
    this.next = 1; this.pending = new Map(); this.answered = new Set();
    this.closed = false; this.inputEnded = false;
    this.chunks = []; this.size = 0;
    child.stdout.on('data', chunk => this.#read(chunk));
    child.stdout.on('error', e => this.fail(rpcError('pi_rpc_io', `stdout error: ${e.message}`)));
    child.stdin.on('error', e => this.fail(rpcError('pi_rpc_io', `stdin error: ${e.message}`)));
    child.on('error', e => this.fail(rpcError('pi_spawn_failed', `pi_spawn_failed: ${e.message}`, {cause: e})));
    // 'exit' is only the process ending; stdout can still hold its last frames. 'close' is the
    // stdio boundary, so the final verdict (and failing pending requests) waits for it.
    trackChild(child);
    child.on('close', (code, signal) => this.fail(rpcError('pi_exited', `Pi exited (${code ?? signal})`)));
  }

  #read(chunk) {
    if (this.closed) return;
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    while (buf.length && !this.closed) {
      const lf = buf.indexOf(0x0a);
      const part = lf < 0 ? buf : buf.subarray(0, lf);
      if (this.size + part.length > this.maxRecordBytes) {
        this.chunks = []; this.size = 0;
        return this.#protocolError(rpcError('pi_record_too_large', `Pi record exceeds ${this.maxRecordBytes} bytes`));
      }
      this.chunks.push(part); this.size += part.length;
      if (lf < 0) return;
      const record = Buffer.concat(this.chunks); this.chunks = []; this.size = 0;
      buf = buf.subarray(lf + 1);
      this.#record(record);
    }
  }

  #record(bytes) {
    if (!bytes.length) return;
    let msg;
    try { msg = JSON.parse(decoder().decode(bytes)); }
    catch { return this.#protocolError(rpcError('pi_invalid_record', 'Pi sent an invalid JSONL record')); }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
      return this.#protocolError(rpcError('pi_invalid_record', 'Pi record is not a typed object'));
    }
    if (msg.type !== 'response') { this.emit('event', msg); return; }
    if (typeof msg.id !== 'string' || msg.id === '') {
      return this.#protocolError(rpcError('pi_invalid_response', 'Pi response has no request id'));
    }
    const p = this.pending.get(msg.id);
    if (!p) {
      const why = this.answered.has(msg.id) ? 'duplicate' : 'unknown';
      return this.#protocolError(rpcError('pi_invalid_response', `Pi sent a ${why} response (${msg.id})`));
    }
    clearTimeout(p.timer); this.pending.delete(msg.id); this.answered.add(msg.id);
    if (msg.command !== p.type || typeof msg.success !== 'boolean') {
      const e = rpcError('pi_invalid_response', `Pi response does not match ${p.type}`, {sent: true});
      p.reject(e); return this.#protocolError(e);
    }
    if (!msg.success) {
      p.reject(rpcError('pi_command_failed', `${p.type} failed: ${typeof msg.error === 'string' ? msg.error : 'rejected'}`,
        {sent: true, responded: true}));
      return;
    }
    p.resolve(msg.data);
  }

  #protocolError(error) {
    if (this.closed) return;
    this.emit('protocolError', error);
    this.fail(error);
  }

  request(type, params = {}) {
    return new Promise((resolve, reject) => {
      if (this.closed || this.inputEnded || this.child.stdin.destroyed || this.child.stdin.writableEnded) {
        reject(rpcError('pi_rpc_closed', 'Pi RPC closed', {sent: false})); return;
      }
      const id = `mybrowse-${this.next++}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(rpcError('pi_rpc_timeout', `Pi RPC timeout: ${type}`, {sent: true}));
      }, this.timeout);
      timer.unref?.();
      this.pending.set(id, {type, resolve, reject, timer});
      try { this.child.stdin.write(JSON.stringify({...params, id, type}) + '\n'); }
      catch (e) {
        clearTimeout(timer); this.pending.delete(id);
        reject(rpcError('pi_rpc_io', `write failed: ${e.message}`, {sent: false}));
      }
    });
  }

  // Closes Pi's stdin (EOF); the child is expected to exit on its own.
  end() {
    if (this.inputEnded) return;
    this.inputEnded = true;
    try { this.child.stdin.end(); } catch {}
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true; this.chunks = []; this.size = 0;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Object.assign(error, {sent: true}));
    }
    this.pending.clear();
    this.emit('closed', error);
  }

  close() { this.fail(rpcError('pi_rpc_closed', 'Pi RPC closed')); }
}

const exited = child => (child.exitCode !== null && child.exitCode !== undefined) || !!child.signalCode;

// 'close' cannot be observed after the fact, so it is recorded from spawn time on.
const trackers = new WeakMap();
function trackChild(child) {
  let t = trackers.get(child);
  if (t) return t;
  t = {closed: false};
  t.promise = new Promise(resolve => child.once('close', () => { t.closed = true; resolve(true); }));
  // A child we first see already exited with its stdio gone has closed; otherwise wait for 'close'.
  const gone = s => !s || s.destroyed || s.readableEnded;
  if (exited(child) && gone(child.stdout) && gone(child.stderr)) t.closed = true;
  trackers.set(child, t);
  return t;
}

function waitClosed(child, ms) {
  const t = trackChild(child);
  if (t.closed) return Promise.resolve(true);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
    t.promise.then(() => { clearTimeout(timer); resolve(true); });
  });
}

// After stdin EOF, waits for the child's 'close' (not just 'exit'). Escalates SIGTERM/SIGKILL only
// against this child and only while the process is still running. Returns false when 'close' never came;
// the stdio pipes are then destroyed so they cannot keep the parent alive.
export async function reapChild(child, {graceMs = 2000, termMs = 1500, killMs = 1500} = {}) {
  trackChild(child);
  let ok = await waitClosed(child, graceMs);
  if (!ok && !exited(child)) {
    try { child.kill('SIGTERM'); } catch {}
    ok = await waitClosed(child, termMs);
    if (!ok && !exited(child)) { try { child.kill('SIGKILL'); } catch {} }
  }
  if (!ok) ok = await waitClosed(child, killMs);
  if (!ok) for (const s of [child.stdout, child.stderr, child.stdin]) { try { s?.destroy(); } catch {} }
  return ok;
}
