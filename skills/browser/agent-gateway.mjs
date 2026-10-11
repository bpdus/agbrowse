// @ts-check
/**
 * Opt-in loopback HTTP gateway for paired-device-v1.
 * Importing this module does not listen. Chrome is not imported or started.
 * Foreground entry: node skills/browser/agent-gateway.mjs --port 7420
 */

import * as http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createAuthService } from './agent-auth.mjs';
import {
    AUTH_ERROR_MESSAGES,
    AgentAuthError,
    authError,
    createDevFileKeyStore,
    createJsonStateStore,
} from './agent-auth-store.mjs';
import { connectReadEndpoint } from './agent-ipc.mjs';
import { createMcpDispatcher } from './agent-mcp.mjs';

const BODY_BYTES = 16 * 1024;
const PROTOCOL_VERSION = '0.1.0';
const STATUS = Object.freeze({
    PAIRING_CLOSED: 403,
    PAIRING_EXPIRED: 403,
    AUTH_INVALID: 401,
    AUTH_EXPIRED: 401,
    CHALLENGE_USED: 401,
    DEVICE_REVOKED: 401,
    SCOPE_DENIED: 403,
    VERSION_UNSUPPORTED: 400,
    RATE_LIMITED: 429,
    STATE_UNSAFE: 500,
    KEY_UNAVAILABLE: 500,
});
const CLI_CODES = new Set([...Object.keys(AUTH_ERROR_MESSAGES), 'INVALID_ARGUMENTS', 'STARTUP_FAILED']);
const HELP = [
    'agbrowse paired-device gateway',
    '',
    'Usage:',
    '  node skills/browser/agent-gateway.mjs --port 7420',
    '  node skills/browser/agent-gateway.mjs --help',
    '',
    'Binds 127.0.0.1 only. The default port is 7420.',
    'GET /healthz returns {"ok":true} and does not require authentication.',
    'POST /mcp serves authenticated read tools.',
    'A gateway without the storage arguments cannot serve authenticated reads.',
    'Persistence flags, all required together:',
    '  --state-dir --key-dir --gateway-id --audience',
    'A --host value other than 127.0.0.1 is rejected.',
    '',
].join('\n');

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {{ status: number, body?: unknown, headers?: Record<string, string> }} outcome
 */
function sendMcp(res, outcome) {
    /** @type {Record<string, string | number>} */
    const headers = {
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...(outcome.headers ?? {}),
    };
    if (outcome.body === undefined) {
        res.writeHead(outcome.status, headers);
        res.end();
        return;
    }
    const body = Buffer.from(JSON.stringify(outcome.body));
    headers['content-type'] = 'application/json; charset=utf-8';
    headers['content-length'] = body.length;
    res.writeHead(outcome.status, headers);
    res.end(body);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {unknown} error
 * @param {number} [statusOverride]
 */
function sendError(res, error, statusOverride) {
    const code = error instanceof AgentAuthError && STATUS[/** @type {keyof typeof STATUS} */ (error.code)]
        ? error.code
        : 'AUTH_INVALID';
    const status = statusOverride
        ?? /** @type {{ status?: number }} */ (error).status
        ?? STATUS[/** @type {keyof typeof STATUS} */ (code)]
        ?? 401;
    const message = AUTH_ERROR_MESSAGES[/** @type {keyof typeof AUTH_ERROR_MESSAGES} */ (code)]
        ?? AUTH_ERROR_MESSAGES.AUTH_INVALID;
    sendJson(res, status, { error: { code, message } });
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isJsonContentType(value) {
    const parts = value.split(';').map((part) => part.trim().toLowerCase()).filter(Boolean);
    if (parts[0] !== 'application/json') return false;
    return parts.length === 1 || (parts.length === 2 && parts[1] === 'charset=utf-8');
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<Buffer>}
 */
function readBody(req) {
    const declared = req.headers['content-length'];
    if (Array.isArray(declared) || (declared !== undefined && !/^\d+$/.test(declared))) {
        return Promise.reject(Object.assign(authError('AUTH_INVALID'), { status: 400 }));
    }
    if (declared !== undefined && Number(declared) > BODY_BYTES) {
        return Promise.reject(Object.assign(authError('AUTH_INVALID'), { status: 413 }));
    }
    if (req.headers['transfer-encoding'] !== undefined) {
        return Promise.reject(Object.assign(authError('AUTH_INVALID'), { status: 400 }));
    }
    return new Promise((resolve, reject) => {
        /** @type {Buffer[]} */
        const chunks = [];
        let total = 0;
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > BODY_BYTES) {
                reject(Object.assign(authError('AUTH_INVALID'), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', () => reject(Object.assign(authError('AUTH_INVALID'), { status: 400 })));
    });
}

/**
 * @param {unknown} value
 * @param {string[]} allowed
 * @returns {Record<string, unknown>}
 */
function parseObject(value, allowed) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw authError('AUTH_INVALID');
    const record = /** @type {Record<string, unknown>} */ (value);
    if (Object.keys(record).some((key) => !allowed.includes(key))) throw authError('AUTH_INVALID');
    if (record.protocol_version !== PROTOCOL_VERSION) throw authError('VERSION_UNSUPPORTED');
    return record;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {string | null}
 */
function singleHeader(req, name) {
    const value = req.headers[name];
    if (value === undefined) return null;
    if (Array.isArray(value) || value.length === 0 || value.length > 256) return '';
    return value;
}

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
function bearerToken(req) {
    const header = singleHeader(req, 'authorization');
    if (!header) return '';
    const match = BEARER.exec(header);
    return match ? match[1] : '';
}

/**
 * @param {{
 *   auth: {
 *     submitPairing: (input: any) => Promise<unknown>,
 *     issueChallenge: (input: any) => Promise<unknown>,
 *     exchangeProof: (input: any) => Promise<unknown>,
 *     authenticate: (token: string) => Promise<any>,
 *   },
 *   port?: number,
 *   allowedHosts: string[],
 *   allowedOrigins?: string[],
 *   host?: string,
 *   mcp?: { handle: (request: any) => Promise<any> },
 *   worker?: { call: (op: string, payload: Record<string, unknown>) => Promise<any> },
 *   log?: (line: string) => void,
 * }} options
 */
export function createGateway(options) {
    const host = options?.host ?? '127.0.0.1';
    if (host !== '127.0.0.1') throw authError('AUTH_INVALID');
    const port = options.port ?? 7420;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw authError('AUTH_INVALID');
    if (!Array.isArray(options.allowedHosts) || options.allowedHosts.length === 0 || options.allowedHosts.some((item) => typeof item !== 'string')) {
        throw authError('AUTH_INVALID');
    }
    const allowedOrigins = new Set(options.allowedOrigins ?? []);
    if ([...allowedOrigins].some((item) => typeof item !== 'string')) throw authError('AUTH_INVALID');
    const mcp = options.mcp ?? createMcpDispatcher({
        worker: options.worker ?? connectReadEndpoint(),
        log: options.log ?? ((line) => { process.stderr.write(line); }),
    });
    let allowedHosts = options.allowedHosts.slice();
    /** @type {http.Server | null} */
    let server = null;
    let starting = false;

    /**
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     */
    async function onRequest(req, res) {
        try {
            const remote = req.socket.remoteAddress;
            if (remote !== '127.0.0.1') {
                sendError(res, authError('AUTH_INVALID'), 403);
                return;
            }
            const hostHeader = singleHeader(req, 'host');
            if (!hostHeader || !allowedHosts.includes(hostHeader)) {
                sendError(res, authError('AUTH_INVALID'), 403);
                return;
            }
            const origin = singleHeader(req, 'origin');
            if (origin === '') {
                sendError(res, authError('AUTH_INVALID'), 403);
                return;
            }
            if (origin !== null && !allowedOrigins.has(origin)) {
                sendError(res, authError('AUTH_INVALID'), 403);
                return;
            }
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            if (url.search) {
                sendError(res, authError('AUTH_INVALID'), 404);
                return;
            }
            if (url.pathname === '/healthz') {
                if (req.method !== 'GET') {
                    sendError(res, authError('AUTH_INVALID'), 405);
                    return;
                }
                sendJson(res, 200, { ok: true });
                return;
            }
            if (url.pathname === '/mcp') {
                const outcome = await mcp.handle({
                    method: req.method,
                    headers: req.headers,
                    readBody: () => readBody(req),
                    authenticate: (token) => options.auth.authenticate(token),
                });
                sendMcp(res, outcome);
                return;
            }
            const route = url.pathname === '/auth/pair' || url.pathname === '/auth/challenge' || url.pathname === '/auth/token';
            if (!route) {
                req.resume();
                const token = bearerToken(req);
                if (!token) {
                    sendError(res, authError('AUTH_INVALID'), 401);
                    return;
                }
                await options.auth.authenticate(token);
                sendError(res, authError('AUTH_INVALID'), 404);
                return;
            }
            if (req.method !== 'POST') {
                sendError(res, authError('AUTH_INVALID'), 405);
                return;
            }
            const contentType = singleHeader(req, 'content-type');
            if (!contentType || !isJsonContentType(contentType)) {
                sendError(res, authError('AUTH_INVALID'), 415);
                return;
            }
            const raw = await readBody(req);
            /** @type {unknown} */
            let parsed;
            try {
                parsed = JSON.parse(raw.toString('utf8'));
            } catch {
                throw Object.assign(authError('AUTH_INVALID'), { status: 400 });
            }
            if (url.pathname === '/auth/pair') {
                const body = parseObject(parsed, ['protocol_version', 'public_key', 'name', 'requested_scopes']);
                const result = await options.auth.submitPairing({
                    publicKey: body.public_key,
                    name: body.name,
                    requestedScopes: body.requested_scopes,
                });
                sendJson(res, 200, result);
                return;
            }
            if (url.pathname === '/auth/challenge') {
                const body = parseObject(parsed, ['protocol_version', 'device_id', 'requested_scopes', 'resource']);
                const result = await options.auth.issueChallenge({
                    deviceId: body.device_id,
                    resource: body.resource,
                    requestedScopes: body.requested_scopes,
                });
                sendJson(res, 200, result);
                return;
            }
            const body = parseObject(parsed, ['protocol_version', 'challenge_id', 'device_id', 'proof']);
            const result = await options.auth.exchangeProof({
                challengeId: body.challenge_id,
                deviceId: body.device_id,
                proof: body.proof,
            });
            sendJson(res, 200, result);
        } catch (error) {
            if (!res.headersSent) sendError(res, error);
            else res.destroy();
        }
    }

    return {
        address() {
            if (!server?.listening) return null;
            return server.address();
        },
        async start() {
            if (server || starting) throw authError('AUTH_INVALID');
            starting = true;
            const created = http.createServer(onRequest);
            created.requestTimeout = 10_000;
            created.headersTimeout = 5_000;
            created.maxHeadersCount = 32;
            created.on('clientError', (_error, socket) => {
                if (socket.writable) {
                    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
                } else {
                    socket.destroy();
                }
            });
            try {
                await new Promise((resolve, reject) => {
                    created.once('error', reject);
                    created.listen({ host: '127.0.0.1', port }, () => {
                        created.removeAllListeners('error');
                        resolve(undefined);
                    });
                });
                const bound = created.address();
                if (!bound || typeof bound === 'string' || bound.address !== '127.0.0.1') {
                    throw authError('AUTH_INVALID');
                }
                if (port === 0) {
                    allowedHosts = options.allowedHosts.map((item) => (
                        item.endsWith(':0') ? `${item.slice(0, -2)}:${bound.port}` : item
                    ));
                }
                server = created;
            } catch (error) {
                created.close();
                if (error instanceof AgentAuthError) throw error;
                throw authError('AUTH_INVALID');
            } finally {
                starting = false;
            }
        },
        async stop() {
            const current = server;
            if (!current) return;
            server = null;
            current.closeAllConnections?.();
            await new Promise((resolve, reject) => {
                current.close((error) => (error ? reject(error) : resolve(undefined)));
            });
        },
    };
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @type {{ help: boolean, port: number, host: string, stateDir?: string, keyDir?: string, gatewayId?: string, audience?: string, allowedHosts: string[], allowedOrigins: string[] }} */
    const args = { help: false, port: 7420, host: '127.0.0.1', allowedHosts: [], allowedOrigins: [] };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            const value = argv[index + 1];
            if (value === undefined || value.startsWith('--')) throw authError('INVALID_ARGUMENTS');
            index += 1;
            return value;
        };
        if (arg === '--help') args.help = true;
        else if (arg === '--port') {
            const value = next();
            if (!/^\d+$/.test(value)) throw authError('INVALID_ARGUMENTS');
            const port = Number(value);
            if (port > 65535) throw authError('INVALID_ARGUMENTS');
            args.port = port;
        } else if (arg === '--host') args.host = next();
        else if (arg === '--state-dir') args.stateDir = next();
        else if (arg === '--key-dir') args.keyDir = next();
        else if (arg === '--gateway-id') args.gatewayId = next();
        else if (arg === '--audience') args.audience = next();
        else if (arg === '--allowed-host') args.allowedHosts.push(next());
        else if (arg === '--allowed-origin') args.allowedOrigins.push(next());
        else throw authError('INVALID_ARGUMENTS');
    }
    return args;
}

/**
 * @param {string} code
 */
function writeCliError(code) {
    const safe = CLI_CODES.has(code) ? code : 'STARTUP_FAILED';
    process.stderr.write(`agbrowse-gateway: error code=${safe}\n`);
}

async function runGatewayCli() {
    /** @type {{ close?: () => void } | null} */
    let auth = null;
    try {
        const args = parseArgs(process.argv.slice(2));
        if (args.help) {
            process.stdout.write(`${HELP}\n`);
            return;
        }
        if (args.host !== '127.0.0.1') {
            writeCliError('AUTH_INVALID');
            process.exitCode = 1;
            return;
        }
        const storage = [args.stateDir, args.keyDir, args.gatewayId, args.audience];
        const present = storage.filter(Boolean).length;
        if (present !== 0 && present !== 4) {
            writeCliError('STATE_UNSAFE');
            process.exitCode = 1;
            return;
        }
        /** @type {http.Server | null} */
        if (present === 4) {
            const stateStore = createJsonStateStore({ directory: /** @type {string} */ (args.stateDir) });
            const keyStore = createDevFileKeyStore({ directory: /** @type {string} */ (args.keyDir) });
            auth = createAuthService({
                stateStore,
                keyStore,
                gatewayId: /** @type {string} */ (args.gatewayId),
                audience: /** @type {string} */ (args.audience),
            });
        } else {
            const fail = () => { throw authError('STATE_UNSAFE'); };
            auth = {
                submitPairing: fail,
                issueChallenge: fail,
                exchangeProof: fail,
                authenticate: fail,
                close() {},
            };
        }
        const portLabel = args.port === 0 ? '0' : String(args.port);
        const gateway = createGateway({
            auth: /** @type {any} */ (auth),
            port: args.port,
            host: '127.0.0.1',
            allowedHosts: args.allowedHosts.length > 0 ? args.allowedHosts : [`127.0.0.1:${portLabel}`],
            allowedOrigins: args.allowedOrigins,
        });
        await gateway.start();
        const bound = gateway.address();
        const port = bound && typeof bound !== 'string' ? bound.port : args.port;
        process.stdout.write(`agbrowse-gateway: listening host=127.0.0.1 port=${port}\n`);
        let stopping = false;
        const shutdown = async () => {
            if (stopping) return;
            stopping = true;
            try {
                await gateway.stop();
                auth?.close?.();
                process.stdout.write('agbrowse-gateway: stopped\n');
                process.exit(0);
            } catch {
                writeCliError('STARTUP_FAILED');
                process.exit(1);
            }
        };
        process.once('SIGINT', () => { shutdown(); });
        process.once('SIGTERM', () => { shutdown(); });
    } catch (error) {
        try { auth?.close?.(); } catch { /* already closed or never opened */ }
        const code = error instanceof AgentAuthError ? error.code : 'STARTUP_FAILED';
        writeCliError(code);
        process.exitCode = 1;
    }
}

function isInvokedDirectly() {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(entry).href;
}

if (isInvokedDirectly()) {
    runGatewayCli().catch(() => {
        process.stderr.write('agbrowse-gateway: error code=STARTUP_FAILED\n');
        process.exit(1);
    });
}
