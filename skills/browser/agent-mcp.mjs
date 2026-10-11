// @ts-check
/**
 * Authenticated MCP dispatcher for the read-only browser tools.
 * Domain protocol 0.1.0 and MCP transport 2025-11-25 are separate.
 * Authentication failures stay on HTTP. Tool failures use MCP isError.
 * This module does not import Playwright or open a CDP port.
 */

import { randomBytes } from 'node:crypto';
import { AgentAuthError } from './agent-auth-store.mjs';
import { KeyedMutex } from './keyed-mutex.mjs';
import { READ_ERROR_MESSAGES, readError } from './agent-read-error.mjs';
import { redactValue } from './agent-redact.mjs';
import { READ_ACTION, createSnapshotStore } from './agent-snapshot.mjs';

export const MCP_PROTOCOL_VERSION = '2025-11-25';
export const DOMAIN_PROTOCOL_VERSION = '0.1.0';
export const READ_SCOPE = 'browser:read';

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const SESSION_ID = /^ses_[a-f0-9]{16}$/;
const REF_ID = /^r_[a-f0-9]{24}$/;
const SNAPSHOT_ID = /^snap_[a-f0-9]{16}$/;
const TAB_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MCP_SESSION_ID = /^mcp_[a-f0-9]{16}$/;
const WORKER_ID = /^wrk_[a-f0-9]{16}$/;
const QUERY_TEXT = /^[^\u0000-\u001f\u007f<>"'`\\]{1,80}$/u;

const TOOL_NAMES = [
    'browser.session.open',
    'browser.session.close',
    'browser.observe',
    'naver.search.list',
    'naver.search.result.read',
];

const TOOLS = [
    {
        name: 'browser.session.open',
        description: 'Open one read-only browser session bound to this device and MCP session.',
        inputSchema: schema(['protocol_version', 'request_id'], {}),
    },
    {
        name: 'browser.session.close',
        description: 'Close a browser session owned by this device and MCP session.',
        inputSchema: schema(['protocol_version', 'request_id', 'session_id'], {}),
    },
    {
        name: 'browser.observe',
        description: 'Return a full snapshot of the current page. Diffs are not returned.',
        inputSchema: schema(['protocol_version', 'request_id', 'session_id'], {
            tab_id: { type: 'string' },
            frame_id: { type: 'string' },
            base_snapshot_id: { type: ['string', 'null'] },
            max_nodes: { type: 'integer' },
        }),
    },
    {
        name: 'naver.search.list',
        description: 'Open the fixed Naver web search page and return listing fields only.',
        inputSchema: schema(['protocol_version', 'request_id', 'session_id', 'query'], {
            max_nodes: { type: 'integer' },
        }),
    },
    {
        name: 'naver.search.result.read',
        description: 'Read one listing item already present in the current snapshot. Does not open the destination.',
        inputSchema: schema(['protocol_version', 'request_id', 'session_id', 'ref'], {}),
    },
];

/**
 * @param {string[]} required
 * @param {Record<string, unknown>} extra
 */
function schema(required, extra) {
    return {
        type: 'object',
        additionalProperties: false,
        required,
        properties: {
            protocol_version: { const: DOMAIN_PROTOCOL_VERSION },
            request_id: { type: 'string' },
            session_id: { type: 'string' },
            query: { type: 'string' },
            ref: { type: 'string' },
            ...extra,
        },
    };
}

/**
 * @param {number} status
 * @param {string} code
 * @param {string} [sessionId]
 * @param {string} [tool]
 * @param {string} [requestId]
 */
function authOutcome(status, code, sessionId, tool = '-', requestId = '-') {
    const safe = Object.hasOwn(READ_ERROR_MESSAGES, code) ? code : 'AUTH_INVALID';
    return {
        status,
        tool,
        requestId,
        headers: sessionHeaders(sessionId),
        body: { error: { code: safe, message: READ_ERROR_MESSAGES[/** @type {keyof typeof READ_ERROR_MESSAGES} */ (safe)] } },
    };
}

/**
 * @param {string | undefined} sessionId
 */
function sessionHeaders(sessionId) {
    /** @type {Record<string, string>} */
    const headers = { 'mcp-protocol-version': MCP_PROTOCOL_VERSION };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    return headers;
}

/**
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @param {string} name
 */
function headerValue(headers, name) {
    const value = headers[name];
    if (value === undefined) return null;
    if (Array.isArray(value)) return '';
    return value;
}

/**
 * @param {import('node:http').IncomingHttpHeaders} headers
 */
function bearerToken(headers) {
    const value = headerValue(headers, 'authorization');
    if (value === null) return null;
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(value);
    return match ? match[1] : '';
}

/**
 * @param {string | null} value
 */
function jsonContentType(value) {
    if (!value) return false;
    const parts = value.split(';').map((part) => part.trim().toLowerCase()).filter(Boolean);
    return parts[0] === 'application/json' && (parts.length === 1 || (parts.length === 2 && parts[1] === 'charset=utf-8'));
}

/**
 * @param {unknown} id
 * @param {number} code
 * @param {string} message
 * @param {string} [sessionId]
 * @param {string} [errorCode]
 */
function rpcError(id, code, message, sessionId, errorCode) {
    return {
        status: 400,
        tool: '-',
        requestId: '-',
        headers: sessionHeaders(sessionId),
        body: {
            jsonrpc: '2.0',
            id: id ?? null,
            error: errorCode ? { code, message, data: { code: errorCode } } : { code, message },
        },
    };
}

/**
 * @param {unknown} id
 * @param {unknown} structured
 * @param {boolean} isError
 * @param {string} sessionId
 * @param {string} requestId
 * @param {string} tool
 */
function toolOutcome(id, structured, isError, sessionId, requestId, tool) {
    const safe = redactValue(structured);
    return {
        status: 200,
        tool,
        requestId,
        headers: sessionHeaders(sessionId),
        body: {
            jsonrpc: '2.0',
            id,
            result: {
                content: [{ type: 'text', text: JSON.stringify(safe) }],
                structuredContent: safe,
                isError,
            },
        },
    };
}

/**
 * @param {unknown} id
 * @param {string} requestId
 * @param {string | undefined} sessionId
 * @param {string} code
 * @param {string} mcpSessionId
 * @param {string} tool
 */
function toolFailure(id, requestId, sessionId, code, mcpSessionId, tool) {
    const error = readError(code);
    return toolOutcome(id, {
        protocol_version: DOMAIN_PROTOCOL_VERSION,
        request_id: requestId,
        ...(sessionId ? { session_id: sessionId } : {}),
        is_error: true,
        error: { code: error.code, message: error.message },
    }, true, mcpSessionId, requestId, tool);
}

/**
 * @param {Record<string, unknown>} args
 * @param {string[]} allowed
 */
function unknownField(args, allowed) {
    return Object.keys(args).some((key) => !allowed.includes(key));
}

/**
 * @param {unknown} value
 * @param {number} [fallback]
 */
function maxNodes(value, fallback) {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || /** @type {number} */ (value) < 1 || /** @type {number} */ (value) > 120) {
        throw readError('INVALID_ARGUMENTS');
    }
    return /** @type {number} */ (value);
}

/**
 * @param {{ worker: { call: (op: string, payload: Record<string, unknown>) => Promise<any> }, log?: (line: string) => void, snapshots?: ReturnType<typeof createSnapshotStore> }} options
 */
export function createMcpDispatcher(options) {
    if (!options?.worker || typeof options.worker.call !== 'function') throw readError('INVALID_ARGUMENTS');
    const snapshots = options.snapshots ?? createSnapshotStore();
    const mutex = new KeyedMutex();
    const log = options.log ?? (() => {});
    /** @type {Map<string, { id: string, deviceId: string, epoch: number, browserSessionIds: Set<string> }>} */
    const mcpSessions = new Map();
    /** @type {Map<string, { sessionId: string, deviceId: string, epoch: number, mcpSessionId: string, tabId: string, frameId: string, documentEpoch: number }>} */
    const bindings = new Map();
    /** @type {string | null} */
    let workerId = null;

    /**
     * @param {string} mcpSessionId
     */
    function dropMcpSession(mcpSessionId) {
        const session = mcpSessions.get(mcpSessionId);
        if (!session) return;
        for (const browserId of session.browserSessionIds) {
            bindings.delete(browserId);
            snapshots.dropSession(browserId);
        }
        mcpSessions.delete(mcpSessionId);
    }

    function dropAll() {
        for (const id of [...mcpSessions.keys()]) dropMcpSession(id);
        snapshots.dropAll();
        bindings.clear();
    }

    /**
     * @param {string} op
     * @param {Record<string, unknown>} payload
     */
    async function invoke(op, payload) {
        const hello = await options.worker.call('worker.hello', {});
        if (!hello || typeof hello.worker_id !== 'string' || !WORKER_ID.test(hello.worker_id)) {
            throw readError('NOT_RUNNING');
        }
        if (workerId && workerId !== hello.worker_id) {
            dropAll();
            workerId = hello.worker_id;
            throw readError('NOT_RUNNING');
        }
        workerId = hello.worker_id;
        return options.worker.call(op, payload);
    }

    /**
     * @param {{ device_id: string, epoch: number }} principal
     * @param {string} mcpSessionId
     * @param {string} sessionId
     */
    function requireBinding(principal, mcpSessionId, sessionId) {
        const binding = bindings.get(sessionId);
        if (!binding) throw readError('ACTION_DENIED');
        if (binding.deviceId !== principal.device_id || binding.epoch !== principal.epoch) throw readError('ACTION_DENIED');
        if (binding.mcpSessionId !== mcpSessionId) throw readError('ACTION_DENIED');
        return binding;
    }

    /**
     * @param {{ device_id: string, epoch: number }} principal
     * @param {{ id: string }} mcpSession
     * @param {string} requestId
     * @param {any} workerResult
     * @param {string | null} baseSnapshotId
     * @param {number} limit
     */
    function commitSnapshot(principal, mcpSession, requestId, workerResult, baseSnapshotId, limit) {
        const binding = bindings.get(workerResult?.session_id || '');
        if (!binding || binding.mcpSessionId !== mcpSession.id) throw readError('ACTION_DENIED');
        if (typeof workerResult.document_epoch !== 'number') throw readError('INTERNAL');
        if (typeof workerResult.tab_id !== 'string' || !TAB_ID.test(workerResult.tab_id)) throw readError('INTERNAL');
        binding.documentEpoch = workerResult.document_epoch;
        binding.tabId = workerResult.tab_id;
        return snapshots.commit({
            deviceId: principal.device_id,
            epoch: principal.epoch,
            sessionId: binding.sessionId,
            tabId: binding.tabId,
            frameId: binding.frameId,
            documentEpoch: workerResult.document_epoch,
            requestId,
            baseSnapshotId,
            page: {
                origin: String(workerResult.page?.origin || ''),
                url: String(workerResult.page?.url || ''),
                title: String(workerResult.page?.title || ''),
            },
            nodes: Array.isArray(workerResult.results) ? workerResult.results : [],
            maxNodes: limit,
        });
    }

    /**
     * @param {any} principal
     * @param {any} mcpSession
     * @param {any} message
     */
    async function callTool(principal, mcpSession, message) {
        const tool = typeof message?.params?.name === 'string' ? message.params.name : '';
        if (!TOOL_NAMES.includes(tool)) return rpcError(message.id, -32602, 'Invalid params', mcpSession.id);
        const args = message?.params?.arguments;
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
            return toolFailure(message.id, '-', undefined, 'INVALID_ARGUMENTS', mcpSession.id, tool);
        }
        const record = /** @type {Record<string, unknown>} */ (args);
        const requestId = typeof record.request_id === 'string' && REQUEST_ID.test(record.request_id) ? record.request_id : '';
        if (!requestId) return toolFailure(message.id, '-', undefined, 'INVALID_ARGUMENTS', mcpSession.id, tool);
        if (record.protocol_version !== DOMAIN_PROTOCOL_VERSION) {
            return toolFailure(message.id, requestId, undefined, 'VERSION_UNSUPPORTED', mcpSession.id, tool);
        }
        try {
            if (tool === 'browser.session.open') {
                if (unknownField(record, ['protocol_version', 'request_id'])) throw readError('INVALID_ARGUMENTS');
                const opened = await mutex.runExclusive(mcpSession.id, () => invoke('browser.session.open', {}));
                if (!opened || !SESSION_ID.test(opened.session_id) || !TAB_ID.test(opened.tab_id) || opened.frame_id !== 'frame_main') {
                    throw readError('INTERNAL');
                }
                bindings.set(opened.session_id, {
                    sessionId: opened.session_id,
                    deviceId: principal.device_id,
                    epoch: principal.epoch,
                    mcpSessionId: mcpSession.id,
                    tabId: opened.tab_id,
                    frameId: 'frame_main',
                    documentEpoch: Number(opened.document_epoch) || 1,
                });
                mcpSession.browserSessionIds.add(opened.session_id);
                return toolOutcome(message.id, {
                    protocol_version: DOMAIN_PROTOCOL_VERSION,
                    request_id: requestId,
                    session_id: opened.session_id,
                    tab_id: opened.tab_id,
                    frame_id: 'frame_main',
                    document_epoch: Number(opened.document_epoch) || 1,
                }, false, mcpSession.id, requestId, tool);
            }

            if (typeof record.session_id !== 'string' || !SESSION_ID.test(record.session_id)) {
                throw readError('INVALID_ARGUMENTS');
            }
            const sessionId = record.session_id;
            let binding;
            try {
                binding = requireBinding(principal, mcpSession.id, sessionId);
            } catch (error) {
                const code = error instanceof Error && 'code' in error ? /** @type {{ code: string }} */ (error).code : 'ACTION_DENIED';
                return authOutcome(403, code, mcpSession.id, tool, requestId);
            }
            if (record.tab_id !== undefined && record.tab_id !== binding.tabId) return authOutcome(403, 'ACTION_DENIED', mcpSession.id, tool, requestId);
            if (record.frame_id !== undefined && record.frame_id !== 'frame_main') return authOutcome(403, 'ACTION_DENIED', mcpSession.id, tool, requestId);

            if (tool === 'browser.session.close') {
                if (unknownField(record, ['protocol_version', 'request_id', 'session_id'])) throw readError('INVALID_ARGUMENTS');
                await mutex.runExclusive(sessionId, async () => {
                    requireBinding(principal, mcpSession.id, sessionId);
                    await invoke('browser.session.close', { session_id: sessionId });
                    bindings.delete(sessionId);
                    snapshots.dropSession(sessionId);
                    mcpSession.browserSessionIds.delete(sessionId);
                });
                return toolOutcome(message.id, {
                    protocol_version: DOMAIN_PROTOCOL_VERSION,
                    request_id: requestId,
                    session_id: sessionId,
                    closed: true,
                }, false, mcpSession.id, requestId, tool);
            }

            if (tool === 'browser.observe') {
                if (unknownField(record, ['protocol_version', 'request_id', 'session_id', 'tab_id', 'frame_id', 'base_snapshot_id', 'max_nodes'])) {
                    throw readError('INVALID_ARGUMENTS');
                }
                const limit = maxNodes(record.max_nodes, 120);
                const base = record.base_snapshot_id === undefined || record.base_snapshot_id === null
                    ? null
                    : record.base_snapshot_id;
                if (base !== null && (typeof base !== 'string' || !SNAPSHOT_ID.test(base))) throw readError('INVALID_ARGUMENTS');
                const snapshot = await mutex.runExclusive(sessionId, async () => {
                    requireBinding(principal, mcpSession.id, sessionId);
                    const current = await invoke('browser.observe', { session_id: sessionId, max_nodes: limit });
                    return commitSnapshot(principal, mcpSession, requestId, { ...current, session_id: sessionId }, base, limit);
                });
                return toolOutcome(message.id, snapshot, false, mcpSession.id, requestId, tool);
            }

            if (tool === 'naver.search.list') {
                if (unknownField(record, ['protocol_version', 'request_id', 'session_id', 'query', 'max_nodes'])) {
                    throw readError('INVALID_ARGUMENTS');
                }
                if (typeof record.query !== 'string' || !QUERY_TEXT.test(record.query.trim())) throw readError('INVALID_ARGUMENTS');
                const limit = maxNodes(record.max_nodes, 20);
                const snapshot = await mutex.runExclusive(sessionId, async () => {
                    requireBinding(principal, mcpSession.id, sessionId);
                    const current = await invoke('naver.search.list', {
                        session_id: sessionId,
                        query: record.query.trim(),
                        max_nodes: limit,
                    });
                    return commitSnapshot(principal, mcpSession, requestId, { ...current, session_id: sessionId }, null, limit);
                });
                return toolOutcome(message.id, snapshot, false, mcpSession.id, requestId, tool);
            }

            if (unknownField(record, ['protocol_version', 'request_id', 'session_id', 'ref'])) throw readError('INVALID_ARGUMENTS');
            if (typeof record.ref !== 'string' || !REF_ID.test(record.ref)) throw readError('INVALID_ARGUMENTS');
            const ref = record.ref;
            try {
                snapshots.resolve({
                    ref,
                    deviceId: principal.device_id,
                    epoch: principal.epoch,
                    sessionId,
                    action: READ_ACTION,
                });
            } catch (error) {
                const code = error instanceof Error && 'code' in error ? /** @type {{ code: string }} */ (error).code : 'STALE_REF';
                return toolFailure(message.id, requestId, sessionId, code, mcpSession.id, tool);
            }
            const read = await mutex.runExclusive(sessionId, async () => {
                requireBinding(principal, mcpSession.id, sessionId);
                const current = await invoke('naver.search.result.read', { session_id: sessionId });
                return snapshots.resolve({
                    ref,
                    deviceId: principal.device_id,
                    epoch: principal.epoch,
                    sessionId,
                    action: READ_ACTION,
                    currentNodes: Array.isArray(current?.results) ? current.results : [],
                    currentEpoch: current?.document_epoch,
                });
            });
            return toolOutcome(message.id, {
                protocol_version: DOMAIN_PROTOCOL_VERSION,
                request_id: requestId,
                session_id: sessionId,
                ref: read.ref,
                rank: read.rank,
                title: read.title,
                snippet: read.snippet,
                url: read.url,
            }, false, mcpSession.id, requestId, tool);
        } catch (error) {
            const code = error instanceof Error && 'code' in error && Object.hasOwn(READ_ERROR_MESSAGES, /** @type {{ code: string }} */ (error).code)
                ? /** @type {{ code: string }} */ (error).code
                : 'INTERNAL';
            if (code === 'ACTION_DENIED' || code === 'SCOPE_DENIED') return authOutcome(403, code, mcpSession.id, tool, requestId);
            return toolFailure(message.id, requestId || '-', typeof record.session_id === 'string' ? record.session_id : undefined, code, mcpSession.id, tool);
        }
    }

    /**
     * @param {{ method?: string, headers: import('node:http').IncomingHttpHeaders, readBody?: () => Promise<Buffer>, authenticate: (token: string) => Promise<any> }} request
     */
    async function handle(request) {
        const started = Date.now();
        let tool = '-';
        let requestId = '-';
        let status = 500;
        try {
            const outcome = await dispatch(request);
            tool = outcome.tool || '-';
            requestId = outcome.requestId || '-';
            status = outcome.status;
            return outcome;
        } finally {
            const names = new Set([...TOOL_NAMES, 'initialize', 'tools/list', 'notifications/initialized', 'delete', '-']);
            const safeTool = names.has(tool) ? tool : 'unknown';
            const safeId = REQUEST_ID.test(requestId) ? requestId : '-';
            const elapsed = Date.now() - started;
            log(`agbrowse-mcp: tool=${safeTool} status=${status} ms=${elapsed} request=${safeId}\n`);
        }
    }

    /**
     * @param {{ method?: string, headers: import('node:http').IncomingHttpHeaders, readBody?: () => Promise<Buffer>, authenticate: (token: string) => Promise<any> }} request
     */
    async function dispatch(request) {
        const method = request.method ?? 'GET';
        const token = bearerToken(request.headers);
        if (!token) return authOutcome(401, 'AUTH_INVALID');
        /** @type {any} */
        let principal;
        try {
            principal = await request.authenticate(token);
        } catch (error) {
            const code = error instanceof AgentAuthError ? error.code : 'AUTH_INVALID';
            const status = code === 'SCOPE_DENIED' ? 403 : (code === 'STATE_UNSAFE' || code === 'KEY_UNAVAILABLE' ? 500 : 401);
            return authOutcome(status, code);
        }
        if (!Array.isArray(principal?.scopes) || !principal.scopes.includes(READ_SCOPE)) {
            return authOutcome(403, 'SCOPE_DENIED');
        }
        if (method === 'GET') return authOutcome(405, 'ACTION_DENIED');
        const headerSession = headerValue(request.headers, 'mcp-session-id');
        if (method === 'DELETE') {
            if (!headerSession || !MCP_SESSION_ID.test(headerSession)) return authOutcome(404, 'ACTION_DENIED');
            const mcpSession = mcpSessions.get(headerSession);
            if (!mcpSession || mcpSession.deviceId !== principal.device_id || mcpSession.epoch !== principal.epoch) {
                return authOutcome(403, 'ACTION_DENIED');
            }
            const ids = [...mcpSession.browserSessionIds];
            for (const sessionId of ids) {
                try {
                    await invoke('browser.session.close', { session_id: sessionId });
                } catch {
                    /* binding is dropped either way */
                }
            }
            dropMcpSession(headerSession);
            return { status: 204, tool: 'delete', requestId: '-', headers: sessionHeaders(headerSession) };
        }
        if (method !== 'POST') return authOutcome(405, 'ACTION_DENIED');
        const contentType = headerValue(request.headers, 'content-type');
        if (!jsonContentType(contentType)) return authOutcome(415, 'INVALID_ARGUMENTS');
        const accept = headerValue(request.headers, 'accept') || '';
        if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
            return authOutcome(406, 'INVALID_ARGUMENTS');
        }
        if (!request.readBody) return authOutcome(400, 'INVALID_ARGUMENTS');
        const raw = await request.readBody();
        /** @type {any} */
        let message;
        try {
            message = JSON.parse(raw.toString('utf8'));
        } catch {
            return rpcError(null, -32700, 'Parse error');
        }
        if (Array.isArray(message) || !message || typeof message !== 'object') return rpcError(null, -32600, 'Invalid request');
        const rpcId = message.id;
        if (message.id !== undefined && typeof message.id !== 'string' && typeof message.id !== 'number') {
            return rpcError(null, -32600, 'Invalid request');
        }
        if (message.method === 'initialize') {
            if (message.params?.protocolVersion !== MCP_PROTOCOL_VERSION) {
                return rpcError(rpcId ?? null, -32602, 'Invalid params', undefined, 'VERSION_UNSUPPORTED');
            }
            const allowed = new Set(['protocolVersion', 'capabilities', 'clientInfo']);
            if (!message.params || typeof message.params !== 'object' || Object.keys(message.params).some((key) => !allowed.has(key))) {
                return rpcError(rpcId ?? null, -32602, 'Invalid params');
            }
            const id = `mcp_${randomBytes(8).toString('hex')}`;
            mcpSessions.set(id, {
                id,
                deviceId: principal.device_id,
                epoch: principal.epoch,
                browserSessionIds: new Set(),
            });
            return {
                status: 200,
                tool: 'initialize',
                requestId: '-',
                headers: sessionHeaders(id),
                body: {
                    jsonrpc: '2.0',
                    id: rpcId ?? null,
                    result: {
                        protocolVersion: MCP_PROTOCOL_VERSION,
                        capabilities: { tools: { listChanged: false } },
                        serverInfo: { name: 'agbrowse-agent-gateway', version: DOMAIN_PROTOCOL_VERSION },
                    },
                },
            };
        }
        const protocolHeader = headerValue(request.headers, 'mcp-protocol-version');
        if (protocolHeader !== MCP_PROTOCOL_VERSION) return rpcError(rpcId ?? null, -32602, 'Invalid params', undefined, 'VERSION_UNSUPPORTED');
        if (!headerSession || !MCP_SESSION_ID.test(headerSession)) return authOutcome(404, 'ACTION_DENIED');
        const mcpSession = mcpSessions.get(headerSession);
        if (!mcpSession || mcpSession.deviceId !== principal.device_id || mcpSession.epoch !== principal.epoch) {
            return authOutcome(403, 'ACTION_DENIED');
        }
        if (message.method === 'notifications/initialized') {
            return { status: 202, tool: 'notifications/initialized', requestId: '-', headers: sessionHeaders(mcpSession.id) };
        }
        if (message.method === 'tools/list') {
            return {
                status: 200,
                tool: 'tools/list',
                requestId: '-',
                headers: sessionHeaders(mcpSession.id),
                body: { jsonrpc: '2.0', id: rpcId ?? null, result: { tools: TOOLS } },
            };
        }
        if (message.method === 'tools/call') return callTool(principal, mcpSession, message);
        return rpcError(rpcId ?? null, -32601, 'Method not found', mcpSession.id);
    }

    return { handle, dropMcpSession, dropAll };
}
