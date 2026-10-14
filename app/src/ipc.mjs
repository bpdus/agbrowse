// Unix socket IPC server for the native MyBrowse WebUI. One connection carries one framed request
// and one framed response. The server shares SessionService with the HTTP API and never closes it;
// a dropped connection never cancels a service command.
import net from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { ServiceError } from './service.mjs';

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_SOCKET_PATH_BYTES = 103;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const LINGER_MS = 2000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const OPS = new Set(['health', 'list', 'get', 'create', 'command', 'events']);
const ENVELOPE_KEYS = ['version', 'id', 'token', 'op', 'payload'];
const CREATE_KEYS = ['prompt', 'engine', 'mode', 'client_id', 'request_id', 'host'];
const COMMAND_KEYS = ['id', 'action', 'text', 'expected_revision', 'request_id', 'host'];

class IpcError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const bad = (message) => new IpcError(400, 'invalid_request', message);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const digest = (value) => createHash('sha256').update(value, 'utf8').digest();

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > MAX_FRAME_BYTES) return null;
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

function errorMessage(id, status, code, message) {
  return { version: 1, id, ok: false, error: { status, code, message } };
}

function checkKeys(obj, allowed, required, what) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw bad(`${what} has unsupported field ${JSON.stringify(key).slice(0, 40)}`);
  }
  for (const key of required) {
    if (obj[key] === undefined) throw bad(`${what}.${key} is required`);
  }
}

function checkString(obj, key, { optional = false } = {}) {
  const v = obj[key];
  if (v === undefined && optional) return;
  if (typeof v !== 'string' || v.trim() === '') throw bad(`${key} must be a non-empty string`);
}

function parseRequest(raw, token) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new IpcError(400, 'invalid_utf8', 'request body is not valid UTF-8');
  }
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    throw new IpcError(400, 'invalid_json', 'request body is not valid JSON');
  }
  if (!isPlainObject(msg)) throw bad('request must be an object');
  const id = typeof msg.id === 'string' && ID_PATTERN.test(msg.id) ? msg.id : null;
  try {
    checkKeys(msg, ENVELOPE_KEYS, ENVELOPE_KEYS, 'request');
    if (msg.version !== 1) throw bad('version must be 1');
    if (id === null) throw bad('id must be 1-128 characters of letters, digits, _ or -');
    if (typeof msg.token !== 'string') throw bad('token must be a string');
    if (typeof msg.op !== 'string' || !OPS.has(msg.op)) throw bad('unsupported op');
    if (!isPlainObject(msg.payload)) throw bad('payload must be an object');
    // Fixed-length digests keep the comparison independent of the supplied token length.
    if (!timingSafeEqual(digest(msg.token), token)) throw new IpcError(401, 'unauthorized', 'invalid token');
  } catch (err) {
    err.requestId = id;
    throw err;
  }
  return { id, op: msg.op, payload: msg.payload };
}

function validatePayload(op, payload) {
  switch (op) {
    case 'health':
      checkKeys(payload, [], [], 'payload');
      break;
    case 'list': {
      checkKeys(payload, ['before_rowid', 'limit'], [], 'payload');
      const { before_rowid: before, limit } = payload;
      if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw bad('before_rowid must be a positive safe integer');
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)) {
        throw bad(`limit must be an integer from 1 to ${MAX_LIMIT}`);
      }
      break;
    }
    case 'get':
      checkKeys(payload, ['id'], ['id'], 'payload');
      checkString(payload, 'id');
      break;
    case 'create':
      checkKeys(payload, CREATE_KEYS, ['prompt', 'engine', 'client_id', 'request_id'], 'payload');
      for (const key of CREATE_KEYS) checkString(payload, key, { optional: true });
      break;
    case 'command':
      checkKeys(payload, COMMAND_KEYS, ['id', 'action', 'expected_revision', 'request_id'], 'payload');
      for (const key of ['id', 'action', 'request_id', 'host']) checkString(payload, key, { optional: true });
      if (payload.text !== undefined && typeof payload.text !== 'string') throw bad('text must be a string');
      if (!Number.isInteger(payload.expected_revision)) throw bad('expected_revision must be an integer');
      break;
    case 'events': {
      checkKeys(payload, ['id', 'after_seq', 'limit'], ['id', 'after_seq'], 'payload');
      checkString(payload, 'id');
      const { after_seq: after, limit } = payload;
      if (!Number.isSafeInteger(after) || after < 0) throw bad('after_seq must be a non-negative safe integer');
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)) {
        throw bad(`limit must be an integer from 1 to ${MAX_LIMIT}`);
      }
      break;
    }
  }
}

function eventsPage(service, payload) {
  const { id, after_seq: after } = payload;
  const limit = payload.limit ?? DEFAULT_LIMIT;
  const rows = service.events(id, after, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  // Reserve room for the envelope so the finished frame stays under the cap.
  const overhead = Buffer.byteLength(JSON.stringify({ version: 1, id: 'x'.repeat(128), ok: true, data: { events: [], next_seq: Number.MAX_SAFE_INTEGER, has_more: false } }));
  let used = overhead;
  let count = 0;
  for (const event of page) {
    used += Buffer.byteLength(JSON.stringify(event)) + 1;
    if (used > MAX_FRAME_BYTES) break;
    count += 1;
  }
  if (page.length > 0 && count === 0) throw new IpcError(413, 'event_too_large', 'the next event exceeds the response limit');
  const events = page.slice(0, count);
  return {
    events,
    next_seq: events.length ? events[events.length - 1].seq : after,
    has_more: hasMore || count < page.length,
  };
}

async function dispatch({ service, hostId }, { op, payload }) {
  if (op === 'health') return { host: hostId, capabilities: service.capabilities() };
  if (op === 'list') return service.listSummaries(payload.before_rowid, payload.limit ?? DEFAULT_LIMIT);
  if (op === 'get') return { session: service.get(payload.id) };
  if (op === 'events') return eventsPage(service, payload);
  if (payload.host !== undefined && payload.host !== hostId) {
    throw new IpcError(409, 'host_mismatch', `this daemon serves host ${hostId}`);
  }
  if (op === 'create') {
    const { prompt, engine, mode, client_id, request_id } = payload;
    return { session: service.create({ prompt, engine, mode, client_id, request_id, host: payload.host }) };
  }
  const { id, action, text, expected_revision, request_id } = payload;
  return { session: await service.command(id, { action, text, expected_revision, request_id }) };
}

function toErrorMessage(id, err) {
  if (err instanceof IpcError || err instanceof ServiceError) {
    return errorMessage(id, err.status, err.code, err.message);
  }
  return errorMessage(id, 500, 'internal_error', 'internal error');
}

// Serves exactly one request on `socket`. Exported for tests that bind a socket outside startIpcServer.
export function attachIpcConnection(socket, { service, hostId, token, receiveTimeoutMs = 15000 }) {
  const tokenDigest = typeof token === 'string' ? digest(token) : null;
  const chunks = [];
  let received = 0;
  let expected = null;
  let settled = false;
  let timer = setTimeout(() => reply(errorMessage(null, 408, 'request_timeout', 'request was not completed in time')), receiveTimeoutMs);

  function stopTimer() {
    clearTimeout(timer);
    timer = null;
  }

  function reply(message) {
    if (settled) return;
    settled = true;
    if (timer) stopTimer();
    chunks.length = 0;
    // Too large -> response_too_large; unserializable (cyclic, BigInt) -> internal_error. Both fallbacks are small.
    const id = message.id ?? null;
    let frame;
    try {
      frame = encodeFrame(message) ?? encodeFrame(errorMessage(id, 500, 'response_too_large', 'response exceeds the 1 MiB frame limit'));
    } catch {
      frame = encodeFrame(errorMessage(id, 500, 'internal_error', 'internal error'));
    }
    if (socket.destroyed || !socket.writable) {
      socket.destroy();
      return;
    }
    // end() flushes with backpressure handling; keep draining input until the peer closes or we time out.
    socket.end(frame);
    socket.resume();
    const linger = setTimeout(() => socket.destroy(), LINGER_MS);
    linger.unref();
    socket.once('close', () => clearTimeout(linger));
  }

  async function finish() {
    let request;
    try {
      const raw = Buffer.concat(chunks, received);
      if (raw.length < 4) throw new IpcError(400, 'invalid_frame', 'incomplete frame header');
      const length = raw.readUInt32BE(0);
      if (length === 0) throw new IpcError(400, 'invalid_frame', 'frame length must not be zero');
      if (length > MAX_FRAME_BYTES) throw new IpcError(413, 'frame_too_large', 'frame exceeds the 1 MiB limit');
      if (raw.length < 4 + length) throw new IpcError(400, 'invalid_frame', 'incomplete frame body');
      if (raw.length > 4 + length) throw new IpcError(400, 'invalid_frame', 'extra data after the first frame');
      request = parseRequest(raw.subarray(4), tokenDigest);
      validatePayload(request.op, request.payload);
    } catch (err) {
      reply(toErrorMessage(err.requestId ?? null, err));
      return;
    }
    try {
      const data = await dispatch({ service, hostId }, request);
      reply({ version: 1, id: request.id, ok: true, data });
    } catch (err) {
      reply(toErrorMessage(request.id, err));
    }
  }

  socket.on('data', (chunk) => {
    if (settled) return;
    chunks.push(chunk);
    received += chunk.length;
    if (expected === null && received >= 4) {
      const length = Buffer.concat(chunks, received).readUInt32BE(0);
      expected = length;
      if (length === 0) reply(errorMessage(null, 400, 'invalid_frame', 'frame length must not be zero'));
      else if (length > MAX_FRAME_BYTES) reply(errorMessage(null, 413, 'frame_too_large', 'frame exceeds the 1 MiB limit'));
    }
    if (!settled && expected !== null && received > 4 + expected) {
      reply(errorMessage(null, 400, 'invalid_frame', 'extra data after the first frame'));
    }
  });
  socket.on('end', () => {
    if (settled) return;
    stopTimer();
    void finish();
  });
  socket.on('error', () => socket.destroy());
  socket.on('close', () => {
    if (timer) stopTimer();
    chunks.length = 0;
  });
}

const identity = (st) => ({ dev: st.dev, ino: st.ino });
const sameIdentity = (st, id) => st.dev === id.dev && st.ino === id.ino;

function validateBaseDir(baseDir) {
  let stat;
  try {
    stat = lstatSync(baseDir);
  } catch {
    throw new Error('IPC baseDir does not exist');
  }
  if (stat.isSymbolicLink()) throw new Error('IPC baseDir must not be a symbolic link');
  if (!stat.isDirectory()) throw new Error('IPC baseDir must be a directory');
}

export async function startIpcServer({ service, token, hostId, baseDir, receiveTimeoutMs = 15000, maxConnections = 32 } = {}) {
  if (!service) throw new TypeError('service is required');
  if (typeof token !== 'string' || token === '') throw new TypeError('token is required');
  if (typeof hostId !== 'string' || hostId === '') throw new TypeError('hostId is required');
  if (!Number.isInteger(maxConnections) || maxConnections < 1) throw new TypeError('maxConnections must be a positive integer');
  if (!(receiveTimeoutMs > 0)) throw new TypeError('receiveTimeoutMs must be positive');

  // macOS exposes /tmp as a symlink; the default is resolved once, explicit baseDirs must not be links.
  const base = baseDir === undefined ? realpathSync('/tmp') : path.resolve(baseDir);
  validateBaseDir(base);
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const prefix = path.join(base, `mybrowse-${uid}-`);
  const longest = Buffer.byteLength(`${prefix}XXXXXX${path.sep}daemon.sock`);
  if (longest > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`IPC socket path would be ${longest} bytes; the limit is ${MAX_SOCKET_PATH_BYTES}`);
  }

  const dir = mkdtempSync(prefix); // new directory, mode 0700
  chmodSync(dir, 0o700);
  const dirId = identity(lstatSync(dir));
  const socketPath = path.join(dir, 'daemon.sock');
  let socketId = null;
  let listening = false;
  const sockets = new Set();
  let closePromise;

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    // Over the limit: refuse at once so no per-connection state or timer outlives the cap.
    if (sockets.size >= maxConnections) {
      socket.on('error', () => {});
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    attachIpcConnection(socket, { service, hostId, token, receiveTimeoutMs });
  });
  const closeServer = () => new Promise((resolve) => server.close(() => resolve()));

  // net.Server.close() unlinks whatever file sits at the socket path, even a foreign replacement.
  // To keep that unlink from reaching a foreign file, the private directory is first renamed to a
  // sibling name, so the automatic unlink only sees a missing path. Only the same-inode socket is
  // then removed from the moved directory. Foreign content is preserved: the directory is renamed
  // back when the original name is still free, otherwise it stays at the sibling name.
  async function shutdown() {
    const moved = path.join(base, `.mybrowse-closing-${randomBytes(6).toString('hex')}`);
    let renamed = false;
    try {
      if (!sameIdentity(lstatSync(dir), dirId)) throw new Error('directory identity changed');
      renameSync(dir, moved);
      renamed = true;
    } catch (err) {
      // Closing now could let the library unlink a path we no longer own. Stop serving instead and
      // leave the filesystem alone.
      server.maxConnections = 0;
      server.unref();
      throw new Error(`IPC cleanup skipped, filesystem left untouched: ${err.message}`);
    }
    await closeServer();
    const movedSocket = path.join(moved, 'daemon.sock');
    try {
      const st = lstatSync(movedSocket);
      if (socketId && st.isSocket() && sameIdentity(st, socketId)) unlinkSync(movedSocket);
    } catch {
      // No socket to remove.
    }
    try {
      if (readdirSync(moved).length === 0) {
        rmdirSync(moved);
        return;
      }
    } catch {
      return;
    }
    try {
      lstatSync(dir);
    } catch (err) {
      if (err.code === 'ENOENT' && renamed) {
        try {
          renameSync(moved, dir);
        } catch {
          // Stays at the sibling name.
        }
      }
    }
  }

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        listening = true;
        resolve();
      });
    });
    socketId = identity(lstatSync(socketPath));
    chmodSync(socketPath, 0o600);
    const stat = lstatSync(socketPath);
    if (!stat.isSocket() || (stat.mode & 0o777) !== 0o600) throw new Error('IPC socket permissions could not be set');
  } catch (err) {
    if (listening) {
      // Post-listen failure: always close the listener. Without a recorded socket identity no file is
      // deleted, so the moved private directory may be kept (restored, or left at its sibling name).
      await shutdown().catch(() => {});
    } else {
      try {
        rmdirSync(dir);
      } catch {
        // Not empty or already gone.
      }
    }
    throw err;
  }

  return {
    socketPath,
    close() {
      closePromise ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await shutdown();
      })();
      return closePromise;
    },
  };
}
