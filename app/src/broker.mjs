// Tool broker: the last check before a tool reaches the browser. It is a standalone boundary
// module; nothing here talks to a real MCP pipe yet, so browserReady must stay false.

// Tools known to only read state. Everything else, including chrome_evaluate and any unknown
// tool, is treated as a mutation.
export const OBSERVATION_TOOLS = new Set([
  'chrome_status', 'chrome_bridge_status', 'chrome_get_info',
  'chrome_user_tabs', 'chrome_session_tabs', 'chrome_screenshot', 'chrome_read_events',
]);

export function isMutationTool(tool) {
  return !OBSERVATION_TOOLS.has(tool);
}

export class BrokerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrokerError';
    this.code = code;
  }
}

function normalizeResource(resource) {
  if (!resource || typeof resource.host !== 'string' || !resource.host) {
    throw new BrokerError('invalid_resource', 'resource.host is required');
  }
  if (typeof resource.profile !== 'string' || !resource.profile) {
    throw new BrokerError('invalid_resource', 'resource.profile is required');
  }
  // tab omitted (or '*') means the whole profile.
  const tab = resource.tab == null || resource.tab === '*' ? '*' : String(resource.tab);
  return { host: resource.host, profile: resource.profile, tab };
}

function overlaps(a, b) {
  return a.host === b.host && a.profile === b.profile && (a.tab === '*' || b.tab === '*' || a.tab === b.tab);
}

function covers(lease, target) {
  return lease.host === target.host && lease.profile === target.profile && (lease.tab === '*' || lease.tab === target.tab);
}

export class Broker {
  #leases = new Map();
  #blocked = new Set();
  #inflight = new Map();

  acquire(sessionId, resource) {
    const wanted = normalizeResource(resource);
    for (const [owner, held] of this.#leases) {
      if (owner !== sessionId && overlaps(held, wanted)) {
        throw new BrokerError('lease_conflict', `resource is held by session ${owner}`);
      }
    }
    this.#leases.set(sessionId, wanted);
    return wanted;
  }

  release(sessionId) {
    this.#leases.delete(sessionId);
  }

  block(sessionId) {
    this.#blocked.add(sessionId);
  }

  allow(sessionId) {
    this.#blocked.delete(sessionId);
  }

  isBlocked(sessionId) {
    return this.#blocked.has(sessionId);
  }

  hasInflightMutation(sessionId) {
    return (this.#inflight.get(sessionId) ?? 0) > 0;
  }

  // Returns a result record; it never throws for a refused or failed call.
  // currentRevision may be a function so the session's revision is read at dispatch time.
  async dispatch({ sessionId, resource, revision, currentRevision, tool, run }) {
    const mutation = isMutationTool(tool);
    if (this.#blocked.has(sessionId)) return { status: 'blocked', executed: false, mutation };
    const latest = typeof currentRevision === 'function' ? currentRevision() : currentRevision;
    if (revision !== latest) return { status: 'stale', executed: false, mutation, revision: latest };
    let target;
    try {
      target = normalizeResource(resource);
    } catch (err) {
      return { status: 'invalid_resource', executed: false, mutation, error: err.message };
    }
    const lease = this.#leases.get(sessionId);
    if (!lease || !covers(lease, target)) return { status: 'no_lease', executed: false, mutation };

    if (mutation) this.#inflight.set(sessionId, (this.#inflight.get(sessionId) ?? 0) + 1);
    try {
      const result = await run();
      return { status: 'ok', executed: true, mutation, result };
    } catch (err) {
      // A mutation that was sent and did not report back may or may not have happened.
      if (mutation) return { status: 'uncertain', executed: 'unknown', mutation, error: String(err?.message ?? err) };
      return { status: 'failed', executed: false, mutation, error: String(err?.message ?? err) };
    } finally {
      if (mutation) {
        const left = this.#inflight.get(sessionId) - 1;
        if (left > 0) this.#inflight.set(sessionId, left);
        else this.#inflight.delete(sessionId);
      }
    }
  }
}
