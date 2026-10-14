// SQLite session store. One file per Mac; every row is scoped to this host.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

export class StoreError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.details = details;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  host TEXT NOT NULL,
  client_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  task TEXT NOT NULL,
  prompt TEXT NOT NULL,
  engine TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  engine_session_id TEXT,
  result TEXT,
  queue TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (host, client_id, request_id)
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS commands (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, request_id)
);
`;

// Statuses that mean an engine may have been running when the process died.
const INTERRUPTED = ['queued', 'running'];
const PATCHABLE = new Set(['status', 'prompt', 'engine_session_id', 'result', 'queue']);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function hashPayload(payload) {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

const now = () => new Date().toISOString();

function rowToSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    host: row.host,
    client_id: row.client_id,
    request_id: row.request_id,
    task: row.task,
    prompt: row.prompt,
    engine: row.engine,
    mode: row.mode,
    status: row.status,
    revision: row.revision,
    engine_session_id: row.engine_session_id ?? null,
    result: row.result == null ? null : JSON.parse(row.result),
    queue: JSON.parse(row.queue),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToEvent(row) {
  return {
    seq: row.seq,
    type: row.type,
    data: row.data == null ? null : JSON.parse(row.data),
    created_at: row.created_at,
  };
}

export class Store {
  constructor(databasePath, hostId) {
    if (typeof databasePath !== 'string' || !databasePath) throw new TypeError('databasePath is required');
    if (typeof hostId !== 'string' || !hostId) throw new TypeError('hostId is required');
    this.hostId = hostId;
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.#recoverInterrupted();
  }

  #tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // A session that was running when the daemon stopped is never re-run automatically.
  #recoverInterrupted() {
    this.#tx(() => {
      const rows = this.db
        .prepare(`SELECT id, status FROM sessions WHERE host = ? AND status IN (${INTERRUPTED.map(() => '?').join(',')})`)
        .all(this.hostId, ...INTERRUPTED);
      const stamp = now();
      for (const row of rows) {
        this.db
          .prepare('UPDATE sessions SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
          .run('uncertain', stamp, row.id);
        this.#insertEvent(row.id, 'recovered_uncertain', { previous_status: row.status }, stamp);
      }
    });
  }

  // Returns { session, created }. The same host/client/request key with a different body is a conflict.
  create(input) {
    const host = input.host ?? this.hostId;
    if (host !== this.hostId) {
      throw new StoreError('host_mismatch', `session host ${host} is not ${this.hostId}`);
    }
    const requestHash = hashPayload({ prompt: input.prompt, engine: input.engine, mode: input.mode });
    return this.#tx(() => {
      const existing = this.db
        .prepare('SELECT * FROM sessions WHERE host = ? AND client_id = ? AND request_id = ?')
        .get(host, input.client_id, input.request_id);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new StoreError('request_conflict', 'request_id was already used with a different body', {
            session_id: existing.id,
          });
        }
        return { session: rowToSession(existing), created: false };
      }
      const id = input.id ?? randomUUID();
      const stamp = now();
      this.db
        .prepare(
          `INSERT INTO sessions (id, host, client_id, request_id, request_hash, task, prompt, engine, mode,
             status, revision, engine_session_id, result, queue, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, '[]', ?, ?)`,
        )
        .run(id, host, input.client_id, input.request_id, requestHash, input.prompt, input.prompt, input.engine,
          input.mode, input.status ?? 'queued', stamp, stamp);
      return { session: rowToSession(this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id)), created: true };
    });
  }

  get(id) {
    return rowToSession(this.db.prepare('SELECT * FROM sessions WHERE id = ? AND host = ?').get(id, this.hostId));
  }

  list() {
    return this.db
      .prepare('SELECT * FROM sessions WHERE host = ? ORDER BY created_at DESC, rowid DESC')
      .all(this.hostId)
      .map(rowToSession);
  }

  // Finite, cursor-based list for IPC: reads only summary columns (title = first 240 chars of task).
  listSummaries(beforeRowid, limit) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
    if (beforeRowid != null && (!Number.isSafeInteger(beforeRowid) || beforeRowid < 1)) {
      throw new TypeError('beforeRowid must be a positive safe integer');
    }
    const cursor = beforeRowid == null ? '' : 'AND rowid < ?';
    const params = beforeRowid == null ? [this.hostId, limit + 1] : [this.hostId, beforeRowid, limit + 1];
    const rows = this.db
      .prepare(
        `SELECT rowid AS row_id, id, host, substr(task, 1, 240) AS title, engine, mode, status, revision, created_at, updated_at
         FROM sessions WHERE host = ? ${cursor} ORDER BY rowid DESC LIMIT ?`,
      )
      .all(...params);
    const page = rows.slice(0, limit);
    return {
      sessions: page.map(({ row_id, ...summary }) => summary),
      next_before_rowid: page.length ? page[page.length - 1].row_id : null,
      has_more: rows.length > limit,
    };
  }

  // bump=false is for bookkeeping (engine ids) that must not invalidate a client's expected_revision.
  update(id, patch, { bump = true, expectedRevision } = {}) {
    const sets = [];
    const values = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!PATCHABLE.has(key)) throw new StoreError('invalid_patch', `cannot update ${key}`);
      sets.push(`${key} = ?`);
      if (key === 'result') values.push(value == null ? null : JSON.stringify(value));
      else if (key === 'queue') values.push(JSON.stringify(value));
      else values.push(value);
    }
    sets.push(`revision = revision + ${bump ? 1 : 0}`, 'updated_at = ?');
    values.push(now(), id, this.hostId);
    let sql = `UPDATE sessions SET ${sets.join(', ')} WHERE id = ? AND host = ?`;
    if (expectedRevision !== undefined) {
      sql += ' AND revision = ?';
      values.push(expectedRevision);
    }
    const info = this.db.prepare(sql).run(...values);
    if (info.changes === 0) {
      const current = this.get(id);
      if (!current) throw new StoreError('not_found', `session ${id} not found`);
      throw new StoreError('stale_revision', 'revision changed', { revision: current.revision });
    }
    return this.get(id);
  }

  #insertEvent(id, type, data, stamp) {
    const { next } = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE session_id = ?')
      .get(id);
    this.db
      .prepare('INSERT INTO events (session_id, seq, type, data, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, next, type, data === undefined ? null : JSON.stringify(data), stamp);
    return { seq: next, type, data: data ?? null, created_at: stamp };
  }

  appendEvent(id, type, data) {
    return this.#tx(() => {
      if (!this.get(id)) throw new StoreError('not_found', `session ${id} not found`);
      return this.#insertEvent(id, type, data, now());
    });
  }

  events(id, afterSeq = 0, limit) {
    if (limit === undefined) {
      return this.db
        .prepare('SELECT seq, type, data, created_at FROM events WHERE session_id = ? AND seq > ? ORDER BY seq')
        .all(id, afterSeq)
        .map(rowToEvent);
    }
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
    return this.db
      .prepare('SELECT seq, type, data, created_at FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(id, afterSeq, limit)
      .map(rowToEvent);
  }

  getCommand(sessionId, requestId) {
    return (
      this.db
        .prepare('SELECT request_id, payload_hash, created_at FROM commands WHERE session_id = ? AND request_id = ?')
        .get(sessionId, requestId) ?? null
    );
  }

  recordCommand(sessionId, requestId, payloadHash) {
    this.db
      .prepare('INSERT INTO commands (session_id, request_id, payload_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(sessionId, requestId, payloadHash, now());
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }
}
