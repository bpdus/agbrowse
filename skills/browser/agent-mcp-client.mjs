// @ts-check
/**
 * Local stdio MCP client. Tokens stay in memory.
 * argv carries directories and the gateway URL only, never secrets.
 * stdout is MCP JSON-RPC. stderr is a fixed error code.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createTokenClient, createHttpsTransport, createLoopbackHttpTransport } from './agent-auth.mjs';
import { AUTH_ERROR_MESSAGES, createDevFileKeyStore } from './agent-auth-store.mjs';
import { MCP_PROTOCOL_VERSION } from './agent-mcp.mjs';
import { READ_ERROR_MESSAGES, readError } from './agent-read-error.mjs';

const CLIENT_FILE = 'client.json';
const HELP = [
    'agbrowse MCP stdio client',
    '',
    'Usage:',
    '  node skills/browser/agent-mcp-client.mjs --client-dir DIR --key-dir DIR --gateway-url URL',
    '  node skills/browser/agent-mcp-client.mjs --help',
    '',
    'Reads the pinned client record and device key from those directories.',
    'Local gateways use explicit loopback HTTP. Other gateways use HTTPS.',
    'Stdout contains MCP messages only.',
    '',
].join('\n');

/**
 * @param {typeof fs} io
 * @param {string} directory
 */
function prepareDirectory(io, directory) {
    if (typeof directory !== 'string' || directory.length === 0 || directory.includes('\0')) throw readError('STATE_UNSAFE');
    const resolved = path.resolve(directory);
    let stat = null;
    try {
        stat = io.lstatSync(resolved);
    } catch (error) {
        if (/** @type {{ code?: string }} */ (error).code !== 'ENOENT') throw readError('STATE_UNSAFE');
    }
    if (!stat) {
        io.mkdirSync(resolved, { mode: 0o700 });
        io.chmodSync(resolved, 0o700);
        stat = io.lstatSync(resolved);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
        throw readError('STATE_UNSAFE');
    }
    return resolved;
}

/**
 * @param {typeof fs} io
 * @param {string} filePath
 */
function assertFile(io, filePath) {
    const stat = io.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
        throw readError('STATE_UNSAFE');
    }
}

/**
 * @param {{ directory: string, fs?: typeof fs }} options
 */
export function createClientStore(options) {
    const io = options.fs ?? fs;
    const directory = prepareDirectory(io, options.directory);
    const filePath = path.join(directory, CLIENT_FILE);
    return {
        /**
         * @param {Record<string, unknown>} record
         */
        save(record) {
            const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
            const tmpPath = path.join(directory, `.${CLIENT_FILE}.${crypto.randomBytes(8).toString('hex')}.tmp`);
            const fd = io.openSync(tmpPath, io.constants.O_WRONLY | io.constants.O_CREAT | io.constants.O_EXCL | io.constants.O_NOFOLLOW, 0o600);
            try {
                io.writeFileSync(fd, bytes);
                io.fsyncSync(fd);
            } finally {
                io.closeSync(fd);
            }
            io.renameSync(tmpPath, filePath);
            assertFile(io, filePath);
        },
        load() {
            assertFile(io, filePath);
            /** @type {any} */
            let parsed;
            try {
                parsed = JSON.parse(io.readFileSync(filePath, 'utf8'));
            } catch {
                throw readError('STATE_UNSAFE');
            }
            if (!parsed || parsed.version !== 1) throw readError('STATE_UNSAFE');
            if (typeof parsed.device_id !== 'string' || typeof parsed.key_id !== 'string') throw readError('STATE_UNSAFE');
            if (typeof parsed.gateway_id !== 'string' || typeof parsed.audience !== 'string') throw readError('STATE_UNSAFE');
            if (!parsed.public_key || typeof parsed.public_key !== 'object') throw readError('STATE_UNSAFE');
            if (!Array.isArray(parsed.scopes) || parsed.scopes.length === 0) throw readError('STATE_UNSAFE');
            return parsed;
        },
    };
}

/**
 * Same-process pairing. The confirmation code is not returned or logged.
 * @param {{ auth: any, deviceKeys: { ensureKey: (id: string) => any }, directory: string, name?: string, scopes?: string[] }} options
 */
export async function bootstrapLocalClient(options) {
    await options.auth.openPairingWindow();
    const publicKey = options.deviceKeys.ensureKey('mcp-client');
    const pending = await options.auth.submitPairing({
        publicKey,
        name: options.name ?? 'local',
        requestedScopes: options.scopes ?? ['browser:read'],
    });
    const confirmed = await options.auth.confirmPairing({
        pendingId: pending.pending_id,
        code: pending.confirmation_code,
        fingerprint: pending.fingerprint,
        grantedScopes: options.scopes ?? ['browser:read'],
    });
    createClientStore({ directory: options.directory }).save({
        version: 1,
        device_id: confirmed.device_id,
        key_id: 'mcp-client',
        gateway_id: confirmed.server.gateway_id,
        audience: confirmed.server.audience,
        resource: confirmed.server.resource,
        public_key: confirmed.server.public_key,
        scopes: options.scopes ?? ['browser:read'],
    });
    return { device_id: confirmed.device_id };
}

/**
 * @param {string} gatewayUrl
 * @param {string} audience
 */
export function assertGatewayUrl(gatewayUrl, audience) {
    let gateway;
    let pinned;
    try {
        gateway = new URL(gatewayUrl);
        pinned = new URL(audience);
    } catch {
        throw readError('AUTH_INVALID');
    }
    if (gateway.origin !== pinned.origin || pinned.pathname !== '/mcp') throw readError('AUTH_INVALID');
    if (gateway.username || gateway.password || gateway.search || gateway.hash) throw readError('AUTH_INVALID');
    if (gateway.protocol === 'http:') {
        createLoopbackHttpTransport({ baseUrl: gateway.origin });
    } else if (gateway.protocol !== 'https:') {
        throw readError('AUTH_INVALID');
    }
    return gateway.origin;
}

/**
 * @param {URL} target
 * @param {Buffer} payload
 * @param {Record<string, string>} headers
 */
function postRaw(target, payload, headers) {
    const transport = target.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const req = transport.request({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port,
            path: `${target.pathname}${target.search}`,
            method: 'POST',
            rejectUnauthorized: true,
            headers: {
                ...headers,
                'content-length': String(payload.length),
                host: target.host,
            },
        }, (res) => {
            /** @type {Buffer[]} */
            const chunks = [];
            let total = 0;
            res.on('data', (chunk) => {
                total += chunk.length;
                if (total > 4 * 1024 * 1024) {
                    req.destroy();
                    reject(readError('INTERNAL'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                resolve({
                    status: res.statusCode ?? 500,
                    headers: res.headers,
                    body: Buffer.concat(chunks),
                });
            });
        });
        req.setTimeout(60000, () => {
            req.destroy();
            reject(readError('INTERNAL'));
        });
        req.on('error', () => reject(readError('INTERNAL')));
        req.end(payload);
    });
}

/**
 * Map a gateway error to the client's fixed public error envelope.
 * @param {unknown} request
 * @param {any} parsed
 * @param {'AUTH_INVALID' | 'INTERNAL'} [unknownCode]
 */
export function mapGatewayError(request, parsed, unknownCode = 'AUTH_INVALID') {
    const code = [parsed?.error?.data?.code, parsed?.error?.code].find((candidate) => (
        typeof candidate === 'string'
        && (Object.hasOwn(READ_ERROR_MESSAGES, candidate) || Object.hasOwn(AUTH_ERROR_MESSAGES, candidate))
    )) ?? unknownCode;
    const failureMessage = Object.hasOwn(READ_ERROR_MESSAGES, code)
        ? READ_ERROR_MESSAGES[/** @type {keyof typeof READ_ERROR_MESSAGES} */ (code)]
        : AUTH_ERROR_MESSAGES[/** @type {keyof typeof AUTH_ERROR_MESSAGES} */ (code)];
    const id = request && typeof request === 'object' && 'id' in request
        ? /** @type {{ id?: unknown }} */ (request).id ?? null
        : null;
    return {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: failureMessage, data: { code } },
    };
}

/**
 * Keep successful results intact while sanitizing JSON-RPC errors, including those returned with HTTP 2xx.
 * @param {unknown} request
 * @param {number} status
 * @param {any} parsed
 */
export function mapGatewayResponse(request, status, parsed) {
    const hasError = parsed !== null && typeof parsed === 'object' && Object.hasOwn(parsed, 'error');
    if (status >= 200 && status < 300) {
        return hasError ? mapGatewayError(request, parsed, 'INTERNAL') : parsed;
    }
    return mapGatewayError(request, parsed);
}

/**
 * @param {{ record: any, keyStore: { sign: (id: string, bytes: Buffer) => Buffer, close?: () => void }, gatewayUrl: string, now?: () => number }} options
 */
export function connectMcpHttp(options) {
    try {
        return createMcpHttpClient(options);
    } catch (error) {
        try { options.keyStore.close?.(); } catch { /* already closed */ }
        throw error;
    }
}

/**
 * @param {{ record: any, keyStore: { sign: (id: string, bytes: Buffer) => Buffer, close?: () => void }, gatewayUrl: string, now?: () => number }} options
 */
function createMcpHttpClient(options) {
    const origin = assertGatewayUrl(options.gatewayUrl, options.record.audience);
    const gateway = new URL(origin);
    const transport = gateway.protocol === 'http:'
        ? createLoopbackHttpTransport({ baseUrl: origin })
        : createHttpsTransport({ origin });
    const tokens = createTokenClient({
        transport,
        keyStore: options.keyStore,
        deviceId: options.record.device_id,
        keyId: options.record.key_id,
        pinnedServer: {
            gateway_id: options.record.gateway_id,
            audience: options.record.audience,
            public_key: options.record.public_key,
            resource: options.record.resource,
        },
        scopes: options.record.scopes,
        now: options.now,
    });
    /** @type {string | null} */
    let mcpSessionId = null;
    let closed = false;

    return {
        /**
         * @param {unknown} message
         */
        async request(message) {
            const token = await tokens.getAccessToken();
            /** @type {Record<string, string>} */
            const headers = {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                'mcp-protocol-version': MCP_PROTOCOL_VERSION,
            };
            if (mcpSessionId) headers['mcp-session-id'] = mcpSessionId;
            const payload = Buffer.from(JSON.stringify(message), 'utf8');
            const response = await postRaw(new URL('/mcp', origin), payload, headers);
            const session = response.headers['mcp-session-id'];
            if (typeof session === 'string' && /^mcp_[a-f0-9]{16}$/.test(session)) mcpSessionId = session;
            if (response.status === 202 || response.status === 204) return null;
            /** @type {any} */
            let parsed;
            try {
                parsed = JSON.parse(response.body.toString('utf8'));
            } catch {
                throw readError('INTERNAL');
            }
            return mapGatewayResponse(message, response.status, parsed);
        },
        close() {
            if (closed) return;
            closed = true;
            try {
                tokens.close();
            } finally {
                options.keyStore.close?.();
            }
        },
    };
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @type {{ help: boolean, clientDir?: string, keyDir?: string, gatewayUrl?: string, scopes?: string[] }} */
    const args = { help: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            const value = argv[index + 1];
            if (value === undefined || value.startsWith('--')) throw readError('INVALID_ARGUMENTS');
            index += 1;
            return value;
        };
        if (arg === '--help') args.help = true;
        else if (arg === '--client-dir') args.clientDir = next();
        else if (arg === '--key-dir') args.keyDir = next();
        else if (arg === '--gateway-url') args.gatewayUrl = next();
        else if (arg === '--scope') { args.scopes ??= []; args.scopes.push(...next().split(',')); }
        else throw readError('INVALID_ARGUMENTS');
    }
    return args;
}

/**
 * @param {{ argv?: string[], stdin?: NodeJS.ReadableStream, stdout?: import('node:stream').Writable, stderr?: import('node:stream').Writable, exit?: (code: number) => void, signalSource?: { on: Function, off?: Function, removeListener?: Function } }} [options]
 */
export async function runMcpStdioClient(options = {}) {
    const argv = options.argv ?? process.argv.slice(2);
    const stdout = options.stdout ?? process.stdout;
    const stderr = options.stderr ?? process.stderr;
    const exit = options.exit ?? ((code) => { process.exitCode = code; });
    /** @type {{ sign: (id: string, bytes: Buffer) => Buffer, close?: () => void } | null} */
    let keys = null;
    /** @type {{ request: (message: unknown) => Promise<any>, close?: () => void } | null} */
    let client = null;
    /** @type {import('node:readline').Interface | null} */
    let lines = null;
    /** @type {130 | 143 | null} */
    let signalCode = null;
    /** @type {(code: 130 | 143) => void} */
    let signalResolve = () => {};
    const signaled = new Promise((resolve) => {
        signalResolve = resolve;
    });
    const signalSource = options.signalSource ?? process;
    const closeStores = () => {
        try { client?.close(); } catch { /* already closed */ }
        try { keys?.close(); } catch { /* already closed */ }
    };
    const onSignal = (signal) => {
        if (signalCode !== null) return;
        signalCode = signal === 'SIGINT' ? 130 : 143;
        try { lines?.close(); } catch { /* input already closed */ }
        closeStores();
        signalResolve(signalCode);
    };
    const onSigint = () => onSignal('SIGINT');
    const onSigterm = () => onSignal('SIGTERM');
    signalSource.on('SIGINT', onSigint);
    signalSource.on('SIGTERM', onSigterm);
    try {
        const args = parseArgs(argv);
        if (args.help) {
            stdout.write(HELP);
            exit(0);
            return 0;
        }
        if (!args.clientDir || !args.keyDir || !args.gatewayUrl) throw readError('INVALID_ARGUMENTS');
        const record = createClientStore({ directory: args.clientDir }).load();
        keys = createDevFileKeyStore({ directory: args.keyDir });
        if (args.scopes) {
            const selected = [...new Set(args.scopes)].sort();
            if (!selected.includes('browser:read') || selected.some((scope) => !/^[a-z0-9:._-]{1,64}$/.test(scope))) throw readError('SCOPE_DENIED');
            record.scopes = selected;
        }
        client = connectMcpHttp({ record, keyStore: keys, gatewayUrl: args.gatewayUrl });
        const input = options.stdin ?? process.stdin;
        lines = readline.createInterface({ input, crlfDelay: Infinity });
        for await (const line of lines) {
            if (signalCode !== null) break;
            if (!line.trim()) continue;
            /** @type {any} */
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                stderr.write('agbrowse-mcp-client: error code=INVALID_ARGUMENTS\n');
                continue;
            }
            const interrupted = Symbol('interrupted');
            const response = await Promise.race([
                client.request(message),
                signaled.then(() => interrupted),
            ]);
            if (response === interrupted || signalCode !== null) break;
            if (response) stdout.write(`${JSON.stringify(response)}\n`);
        }
        const status = signalCode ?? 0;
        exit(status);
        return status;
    } catch (error) {
        if (signalCode !== null) {
            exit(signalCode);
            return signalCode;
        }
        const code = error && typeof /** @type {{ code?: string }} */ (error).code === 'string'
            && Object.hasOwn(READ_ERROR_MESSAGES, /** @type {{ code: string }} */ (error).code)
            ? /** @type {{ code: string }} */ (error).code
            : 'INTERNAL';
        stderr.write(`agbrowse-mcp-client: error code=${code}\n`);
        exit(1);
        return 1;
    } finally {
        if (typeof signalSource.off === 'function') {
            signalSource.off('SIGINT', onSigint);
            signalSource.off('SIGTERM', onSigterm);
        } else if (typeof signalSource.removeListener === 'function') {
            signalSource.removeListener('SIGINT', onSigint);
            signalSource.removeListener('SIGTERM', onSigterm);
        }
        closeStores();
    }
}

function isInvokedDirectly() {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(entry).href;
}

if (isInvokedDirectly()) {
    runMcpStdioClient().catch(() => {
        process.stderr.write('agbrowse-mcp-client: error code=INTERNAL\n');
        process.exit(1);
    });
}
