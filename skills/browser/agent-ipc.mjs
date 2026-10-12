// @ts-check
/**
 * Owner-only Unix socket between the gateway and the browser worker.
 * Messages are length-bounded and allowlisted. Payloads are not logged.
 * This module does not open a CDP port or import Playwright.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { READ_ERROR_MESSAGES, readError } from './agent-read-error.mjs';

export const SOCKET_NAME = 'agent-worker.sock';
const MAX_MESSAGE = 64 * 1024;
const MAX_RESPONSE = 4 * 1024 * 1024;
const ALLOWED_OPS = new Set([
    'browser.observe',
    'browser.session.close',
    'browser.session.open',
    'naver.search.list',
    'naver.login_status',
    'naver.search.result.read',
    'naver.product.read',
    'naver.cart.read',
    'naver.cart.prepare',
    'naver.cart.set',
    'worker.hello',
    'login.start', 'login.end', 'login.status', 'login.navigate', 'login.screenshot', 'login.snapshot', 'login.click', 'login.type', 'login.press', 'worker.restart', 'credentials.naver.save',
]);

export function isAllowedWorkerOperation(op) {
    return typeof op === 'string' && ALLOWED_OPS.has(op);
}

/**
 * @param {string} [home]
 */
export function defaultSocketPath(home = homedir()) {
    return path.join(home, '.agbrowse-bpdus', SOCKET_NAME);
}

/**
 * @param {string} socketPath
 */
function prepareSocketPath(socketPath) {
    if (typeof socketPath !== 'string' || socketPath.length === 0 || socketPath.includes('\0')) {
        throw readError('STATE_UNSAFE');
    }
    const resolved = path.resolve(socketPath);
    if (path.basename(resolved) !== SOCKET_NAME) throw readError('STATE_UNSAFE');
    const parent = path.dirname(resolved);
    let parentStat = null;
    try {
        parentStat = fs.lstatSync(parent);
    } catch (error) {
        const code = /** @type {{ code?: string }} */ (error).code;
        if (code !== 'ENOENT') throw readError('STATE_UNSAFE');
    }
    if (!parentStat) {
        fs.mkdirSync(parent, { mode: 0o700 });
        fs.chmodSync(parent, 0o700);
        parentStat = fs.lstatSync(parent);
    }
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory() || parentStat.uid !== process.getuid()) {
        throw readError('STATE_UNSAFE');
    }
    if ((parentStat.mode & 0o777) !== 0o700) {
        fs.chmodSync(parent, 0o700);
        parentStat = fs.lstatSync(parent);
    }
    if (parentStat.isSymbolicLink() || (parentStat.mode & 0o777) !== 0o700) throw readError('STATE_UNSAFE');
    if (fs.realpathSync(parent) !== path.resolve(parent)) throw readError('STATE_UNSAFE');
    if (fs.existsSync(resolved)) {
        const current = fs.lstatSync(resolved);
        if (current.isSymbolicLink()) throw readError('STATE_UNSAFE');
    }
    return resolved;
}

/**
 * @param {string} socketPath
 * @returns {Promise<boolean>}
 */
function socketIsLive(socketPath) {
    return new Promise((resolve) => {
        const socket = net.createConnection(socketPath);
        const finish = (/** @type {boolean} */ live) => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(live);
        };
        socket.setTimeout(200);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

/**
 * @param {string} line
 */
function parseMessage(line) {
    if (Buffer.byteLength(line) > MAX_MESSAGE) throw readError('INVALID_ARGUMENTS');
    /** @type {any} */
    let message;
    try {
        message = JSON.parse(line);
    } catch {
        throw readError('INVALID_ARGUMENTS');
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw readError('INVALID_ARGUMENTS');
    if (typeof message.id !== 'string' || !/^[a-f0-9]{16}$/.test(message.id)) throw readError('INVALID_ARGUMENTS');
    if (!isAllowedWorkerOperation(message.op)) throw readError('ACTION_DENIED');
    if (message.payload === null || typeof message.payload !== 'object' || Array.isArray(message.payload)) {
        throw readError('INVALID_ARGUMENTS');
    }
    return { id: message.id, op: message.op, payload: /** @type {Record<string, unknown>} */ (message.payload) };
}

/**
 * @param {{ socketPath?: string, dispatch: (op: string, payload: Record<string, unknown>) => Promise<unknown>, log?: (line: string) => void }} options
 */
export async function startReadEndpoint(options) {
    const socketPath = prepareSocketPath(options.socketPath ?? defaultSocketPath());
    if (fs.existsSync(socketPath)) {
        if (await socketIsLive(socketPath)) throw readError('ALREADY_RUNNING');
        const current = fs.lstatSync(socketPath);
        if (current.isSymbolicLink()) throw readError('STATE_UNSAFE');
        fs.unlinkSync(socketPath);
    }
    const workerId = `wrk_${randomBytes(8).toString('hex')}`;
    const log = options.log ?? (() => {});
    /** @type {net.Server} */
    const server = net.createServer((socket) => {
        socket.setEncoding('utf8');
        let buffer = '';
        let chain = Promise.resolve();
        const reply = (/** @type {Record<string, unknown>} */ message) => {
            const line = `${JSON.stringify(message)}\n`;
            if (Buffer.byteLength(line) > MAX_RESPONSE) {
                const id = typeof message.id === 'string' && /^[a-f0-9]{16}$/.test(message.id) ? message.id : '0'.repeat(16);
                socket.write(`${JSON.stringify({ id, ok: false, error: { code: 'INVALID_ARGUMENTS', message: READ_ERROR_MESSAGES.INVALID_ARGUMENTS } })}\n`);
                return;
            }
            socket.write(line);
        };
        /**
         * @param {string} line
         */
        const handleLine = (line) => {
            chain = chain.then(async () => {
                const started = Date.now();
                /** @type {string} */
                let op = 'unknown';
                /** @type {string} */
                let id = '-';
                let status = 'error';
                try {
                    const message = parseMessage(line);
                    id = message.id;
                    op = message.op;
                    const result = message.op === 'worker.hello'
                        ? { worker_id: workerId }
                        : await options.dispatch(message.op, message.payload);
                    status = 'ok';
                    reply({ id: message.id, ok: true, result });
                } catch (error) {
                    const code = error && typeof /** @type {{ code?: string }} */ (error).code === 'string'
                        && Object.hasOwn(READ_ERROR_MESSAGES, /** @type {{ code: string }} */ (error).code)
                        ? /** @type {{ code: string }} */ (error).code
                        : 'INTERNAL';
                    const safe = readError(code);
                    status = safe.code;
                    reply({
                        id: /^[a-f0-9]{16}$/.test(id) ? id : '0'.repeat(16),
                        ok: false,
                        error: { code: safe.code, message: safe.message },
                    });
                } finally {
                    const ms = Date.now() - started;
                    log(`agbrowse-worker: op=${ALLOWED_OPS.has(op) ? op : 'unknown'} status=${status} ms=${ms}\n`);
                }
            }).then(() => undefined, () => undefined);
        };
        socket.on('data', (chunk) => {
            buffer += chunk;
            if (Buffer.byteLength(buffer) > MAX_MESSAGE * 2) {
                socket.destroy();
                return;
            }
            let newline = buffer.indexOf('\n');
            while (newline !== -1) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                if (line) handleLine(line);
                newline = buffer.indexOf('\n');
            }
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => {
            server.removeAllListeners('error');
            resolve(undefined);
        });
    });
    fs.chmodSync(socketPath, 0o600);
    const bound = fs.lstatSync(socketPath);
    if (bound.isSymbolicLink() || (bound.mode & 0o777) !== 0o600 || bound.uid !== process.getuid()) {
        server.close();
        throw readError('STATE_UNSAFE');
    }
    return {
        socketPath,
        workerId,
        async close() {
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(() => resolve(undefined)));
            try {
                const stat = fs.lstatSync(socketPath);
                if (!stat.isSymbolicLink()) fs.unlinkSync(socketPath);
            } catch {
                /* already removed */
            }
        },
    };
}

/**
 * @param {{ socketPath?: string }} [options]
 */
export function connectReadEndpoint(options = {}) {
    const socketPath = options.socketPath ?? defaultSocketPath();
    /** @type {net.Socket | null} */
    let socket = null;
    let buffer = '';
    /** @type {Map<string, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
    const pending = new Map();
    let chain = Promise.resolve();

    function failAll() {
        for (const [id, waiter] of pending) {
            pending.delete(id);
            waiter.reject(readError('NOT_RUNNING'));
        }
    }

    async function ensure() {
        if (socket && !socket.destroyed) return;
        const prepared = prepareSocketPath(socketPath);
        let stat;
        try {
            stat = fs.lstatSync(prepared);
        } catch (error) {
            if (error && /** @type {{ code?: string }} */ (error).code === 'STATE_UNSAFE') throw error;
            throw readError('NOT_RUNNING');
        }
        if (stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) throw readError('STATE_UNSAFE');
        buffer = '';
        socket = net.createConnection(prepared);
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
            buffer += chunk;
            if (Buffer.byteLength(buffer) > MAX_RESPONSE * 2) {
                socket?.destroy();
                failAll();
                return;
            }
            let newline = buffer.indexOf('\n');
            while (newline !== -1) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                newline = buffer.indexOf('\n');
                if (!line) continue;
                /** @type {any} */
                let message;
                try {
                    message = JSON.parse(line);
                } catch {
                    continue;
                }
                const waiter = pending.get(message.id);
                if (!waiter) continue;
                pending.delete(message.id);
                if (message.ok) waiter.resolve(message.result);
                else waiter.reject(readError(typeof message.error?.code === 'string' ? message.error.code : 'INTERNAL'));
            }
        });
        socket.on('error', () => failAll());
        socket.on('close', () => failAll());
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                socket?.destroy();
                reject(readError('NOT_RUNNING'));
            }, 1000);
            socket?.once('connect', () => {
                clearTimeout(timer);
                resolve(undefined);
            });
            socket?.once('error', () => {
                clearTimeout(timer);
                reject(readError('NOT_RUNNING'));
            });
        });
    }

    /**
     * @param {string} op
     * @param {Record<string, unknown>} payload
     */
    function call(op, payload) {
        const run = chain.then(async () => {
            if (!ALLOWED_OPS.has(op)) throw readError('ACTION_DENIED');
            await ensure();
            const id = randomBytes(8).toString('hex');
            const line = `${JSON.stringify({ id, op, payload })}\n`;
            if (Buffer.byteLength(line) > MAX_MESSAGE) throw readError('INVALID_ARGUMENTS');
            const result = new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
            });
            socket?.write(line);
            return await result;
        });
        chain = run.then(() => undefined, () => undefined);
        return run;
    }

    return {
        call,
        close() {
            socket?.destroy();
            socket = null;
            failAll();
        },
    };
}
