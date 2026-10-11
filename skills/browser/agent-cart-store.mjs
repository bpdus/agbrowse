// @ts-check
/** Owner-only durable state for prepared cart intents and idempotency records. */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readError } from './agent-read-error.mjs';

const STATE_FILE = 'cart-state.json';
const LOCK_FILE = '.cart-state.lock';
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const ID = /^[A-Za-z0-9._:-]{1,160}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const INTENT_KEYS = [
    'account_key', 'cart_fingerprint', 'created_at', 'current_quantity', 'device_id', 'dry_run', 'epoch',
    'expires_at', 'intent_id', 'layout_version', 'mcp_session_id', 'option_ids', 'product_fingerprint', 'product_id',
    'session_id', 'target_quantity', 'unrelated_lines_fingerprint', 'unit_price_krw', 'variant_id', 'worker_id',
].sort().join(',');
const OPERATION_KEYS = [
    'account_key', 'created_at', 'device_id', 'idempotency_key', 'intent_id', 'operation_id',
    'request_digest', 'result', 'status',
].sort().join(',');
const OPERATION_FINISHED_KEYS = [...OPERATION_KEYS.split(','), 'finished_at'].sort().join(',');
const VERIFICATION_BASES = new Set([
    'no_mutation_dispatched',
    'cart_only_response_and_matching_readback',
    'manual_reconciliation',
]);

function plain(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
}

function fail() {
    throw readError('STATE_UNSAFE');
}

function validIntent(intent) {
    return plain(intent)
        && Object.keys(intent).sort().join(',') === INTENT_KEYS
        && typeof intent.intent_id === 'string' && /^ci_[a-f0-9]{24}$/.test(intent.intent_id)
        && typeof intent.device_id === 'string' && ID.test(intent.device_id)
        && Number.isSafeInteger(intent.epoch) && intent.epoch >= 0
        && typeof intent.mcp_session_id === 'string' && /^mcp_[a-f0-9]{16}$/.test(intent.mcp_session_id)
        && typeof intent.session_id === 'string' && /^ses_[a-f0-9]{16}$/.test(intent.session_id)
        && typeof intent.worker_id === 'string' && /^wrk_[a-f0-9]{16}$/.test(intent.worker_id)
        && typeof intent.account_key === 'string' && ID.test(intent.account_key)
        && typeof intent.product_id === 'string' && ID.test(intent.product_id)
        && typeof intent.product_fingerprint === 'string' && ID.test(intent.product_fingerprint)
        && typeof intent.variant_id === 'string' && ID.test(intent.variant_id)
        && Array.isArray(intent.option_ids) && intent.option_ids.length <= 12
        && intent.option_ids.every((item) => typeof item === 'string' && ID.test(item))
        && Number.isInteger(intent.current_quantity) && intent.current_quantity >= 0 && intent.current_quantity <= 99
        && Number.isInteger(intent.target_quantity) && intent.target_quantity >= 1 && intent.target_quantity <= 99
        && Number.isSafeInteger(intent.unit_price_krw) && intent.unit_price_krw >= 0
        && typeof intent.layout_version === 'string' && ID.test(intent.layout_version)
        && typeof intent.cart_fingerprint === 'string' && ID.test(intent.cart_fingerprint)
        && typeof intent.unrelated_lines_fingerprint === 'string' && ID.test(intent.unrelated_lines_fingerprint)
        && typeof intent.dry_run === 'boolean'
        && Number.isSafeInteger(intent.created_at) && intent.created_at >= 0
        && Number.isSafeInteger(intent.expires_at) && intent.expires_at > intent.created_at;
}

function validOperationResult(result) {
    if (result === null) return true;
    if (!plain(result)) return false;
    const allowed = new Set(['status', 'quantity', 'unit_price_krw', 'site_changed', 'order_created', 'verification_basis']);
    if (Object.keys(result).some((key) => !allowed.has(key))) return false;
    if (typeof result.status !== 'string'
        || !['SUCCEEDED', 'FAILED', 'OUTCOME_UNKNOWN'].includes(result.status)) return false;
    if (result.quantity !== undefined && (!Number.isInteger(result.quantity) || result.quantity < 0 || result.quantity > 99)) return false;
    if (result.unit_price_krw !== undefined && (!Number.isSafeInteger(result.unit_price_krw) || result.unit_price_krw < 0)) return false;
    if (result.site_changed !== undefined && typeof result.site_changed !== 'boolean') return false;
    if (result.order_created !== undefined && typeof result.order_created !== 'boolean') return false;
    if (result.verification_basis !== undefined && !VERIFICATION_BASES.has(result.verification_basis)) return false;
    return true;
}

function validOperation(operation) {
    if (!plain(operation)) return false;
    const keys = Object.keys(operation).sort().join(',');
    if (keys !== OPERATION_KEYS && keys !== OPERATION_FINISHED_KEYS) return false;
    return typeof operation.operation_id === 'string' && /^co_[a-f0-9]{24}$/.test(operation.operation_id)
        && typeof operation.device_id === 'string' && ID.test(operation.device_id)
        && typeof operation.account_key === 'string' && ID.test(operation.account_key)
        && typeof operation.intent_id === 'string' && /^ci_[a-f0-9]{24}$/.test(operation.intent_id)
        && typeof operation.idempotency_key === 'string' && operation.idempotency_key.length >= 1 && operation.idempotency_key.length <= 64
        && typeof operation.request_digest === 'string' && DIGEST.test(operation.request_digest)
        && ['DISPATCHING', 'SUCCEEDED', 'FAILED', 'OUTCOME_UNKNOWN'].includes(operation.status)
        && Number.isSafeInteger(operation.created_at) && operation.created_at >= 0
        && validOperationResult(operation.result)
        && (operation.finished_at === undefined
            ? operation.status === 'DISPATCHING' && operation.result === null
            : Number.isSafeInteger(operation.finished_at) && operation.finished_at >= operation.created_at
                && operation.status !== 'DISPATCHING' && operation.result !== null);
}

function assertNoSymlinks(io, resolved) {
    const root = path.parse(resolved).root;
    let cursor = root;
    for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        let stat;
        try { stat = io.lstatSync(cursor); } catch (error) {
            if (/** @type {{ code?: string }} */ (error).code === 'ENOENT') return;
            fail();
        }
        if (stat.isSymbolicLink()) fail();
    }
}

function ensureDirectory(io, directory) {
    if (typeof directory !== 'string' || directory.length === 0 || directory.includes('\0')) fail();
    const resolved = path.resolve(directory);
    assertNoSymlinks(io, resolved);
    if (!io.existsSync(resolved)) {
        try { io.mkdirSync(resolved, { mode: 0o700 }); } catch { fail(); }
    }
    let stat;
    try { stat = io.lstatSync(resolved); } catch { fail(); }
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) fail();
    if (io.realpathSync(resolved) !== resolved) fail();
    return resolved;
}

function emptyState() {
    return { version: 1, intents: [], operations: [] };
}

function validateState(value) {
    if (!plain(value) || Object.keys(value).sort().join(',') !== 'intents,operations,version'
        || value.version !== 1 || !Array.isArray(value.intents) || !Array.isArray(value.operations)
        || value.intents.length > 5000 || value.operations.length > 20000) fail();
    if (!value.intents.every(validIntent) || !value.operations.every(validOperation)) fail();
    if (new Set(value.intents.map((intent) => intent.intent_id)).size !== value.intents.length) fail();
    if (new Set(value.operations.map((operation) => operation.operation_id)).size !== value.operations.length) fail();
    const operationKeys = value.operations.map((operation) => `${operation.device_id}\0${operation.account_key}\0${operation.idempotency_key}`);
    if (new Set(operationKeys).size !== operationKeys.length) fail();
    return value;
}

/** @param {any} io @param {string} directory */
function lock(io, directory) {
    const filename = path.join(directory, LOCK_FILE);
    for (let attempt = 0; attempt < 2; attempt += 1) {
        let fd;
        try {
            fd = io.openSync(filename, io.constants.O_WRONLY | io.constants.O_CREAT | io.constants.O_EXCL | io.constants.O_NOFOLLOW, 0o600);
            io.fchmodSync(fd, 0o600);
            io.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce: randomBytes(8).toString('hex') }));
            io.fsyncSync(fd);
            const stat = io.fstatSync(fd);
            if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) fail();
            return () => {
                try { io.closeSync(fd); } catch { /* close best effort after durable transaction */ }
                try {
                    const current = io.lstatSync(filename);
                    if (!current.isSymbolicLink() && current.ino === stat.ino && current.dev === stat.dev) io.unlinkSync(filename);
                } catch { /* already removed */ }
            };
        } catch (error) {
            if (fd !== undefined) {
                try { io.closeSync(fd); } catch { /* already closed */ }
            }
            const code = /** @type {{ code?: string }} */ (error).code;
            if (code !== 'EEXIST' || attempt > 0) fail();
            let previous;
            let stat;
            try {
                stat = io.lstatSync(filename);
                if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) fail();
                previous = JSON.parse(io.readFileSync(filename, 'utf8'));
            } catch { fail(); }
            if (!plain(previous) || !Number.isSafeInteger(previous.pid) || typeof previous.nonce !== 'string') fail();
            try {
                process.kill(previous.pid, 0);
                fail();
            } catch (probeError) {
                if (/** @type {{ code?: string }} */ (probeError).code !== 'ESRCH') fail();
            }
            try {
                const current = io.lstatSync(filename);
                if (current.ino !== stat.ino || current.dev !== stat.dev || current.isSymbolicLink()) fail();
                io.unlinkSync(filename);
            } catch { fail(); }
        }
    }
    fail();
}

/** @param {any} io @param {string} directory */
function readState(io, directory) {
    const filename = path.join(directory, STATE_FILE);
    let state;
    try {
        const stat = io.lstatSync(filename);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_STATE_BYTES) fail();
        state = JSON.parse(io.readFileSync(filename, 'utf8'));
    } catch (error) {
        if (/** @type {{ code?: string }} */ (error).code === 'ENOENT') return emptyState();
        if (error && typeof error === 'object' && 'code' in error && error.code === 'STATE_UNSAFE') throw error;
        fail();
    }
    return validateState(state);
}

/** @param {any} io @param {string} directory @param {any} state */
function writeState(io, directory, state) {
    const serialized = JSON.stringify(validateState(state));
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) fail();
    const target = path.join(directory, STATE_FILE);
    const temporary = path.join(directory, `.cart-state-${randomBytes(8).toString('hex')}.tmp`);
    let fd;
    try {
        fd = io.openSync(temporary, io.constants.O_WRONLY | io.constants.O_CREAT | io.constants.O_EXCL | io.constants.O_NOFOLLOW, 0o600);
        io.fchmodSync(fd, 0o600);
        io.writeFileSync(fd, serialized);
        io.fsyncSync(fd);
        const stat = io.fstatSync(fd);
        if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) fail();
        io.closeSync(fd);
        fd = undefined;
        io.renameSync(temporary, target);
        const dirFd = io.openSync(directory, io.constants.O_RDONLY | io.constants.O_DIRECTORY);
        try { io.fsyncSync(dirFd); } finally { io.closeSync(dirFd); }
    } catch {
        if (fd !== undefined) {
            try { io.closeSync(fd); } catch { /* already closed */ }
        }
        try { io.unlinkSync(temporary); } catch { /* absent */ }
        fail();
    }
}

/**
 * @param {{ directory: string, fs?: typeof fs, now?: () => number }} options
 */
export function createCartStore(options) {
    if (!options || typeof options !== 'object' || typeof options.directory !== 'string') fail();
    const io = options.fs ?? fs;
    const directory = ensureDirectory(io, options.directory);
    const now = options.now ?? Date.now;

    function transact(fn) {
        assertNoSymlinks(io, directory);
        const unlock = lock(io, directory);
        try {
            const state = readState(io, directory);
            const result = fn(state);
            writeState(io, directory, state);
            return result;
        } finally { unlock(); }
    }

    function saveIntent(intent) {
        if (!validIntent(intent)) fail();
        return transact((state) => {
            state.intents = state.intents.filter((item) => item.expires_at > now());
            if (state.intents.some((item) => item.intent_id === intent.intent_id)) fail();
            state.intents.push(JSON.parse(JSON.stringify(intent)));
            return intent.intent_id;
        });
    }

    function claimOperation(input) {
        if (!plain(input) || typeof input.device_id !== 'string' || !ID.test(input.device_id)
            || typeof input.account_key !== 'string' || !ID.test(input.account_key)
            || typeof input.idempotency_key !== 'string' || input.idempotency_key.length < 1 || input.idempotency_key.length > 64
            || typeof input.request_digest !== 'string' || !DIGEST.test(input.request_digest)
            || typeof input.intent_id !== 'string' || !ID.test(input.intent_id)) fail();
        return transact((state) => {
            const existing = state.operations.find((item) => item.device_id === input.device_id
                && item.account_key === input.account_key && item.idempotency_key === input.idempotency_key);
            if (existing) {
                if (existing.request_digest !== input.request_digest) throw readError('IDEMPOTENCY_CONFLICT');
                return { duplicate: true, operation: { ...existing } };
            }
            if (state.operations.some((item) => item.account_key === input.account_key && item.status === 'OUTCOME_UNKNOWN')) {
                throw readError('ACCOUNT_BLOCKED');
            }
            const intent = state.intents.find((item) => item.intent_id === input.intent_id && item.device_id === input.device_id
                && item.account_key === input.account_key && item.expires_at > now());
            if (!intent) throw readError('INTENT_EXPIRED');
            const operation = {
                operation_id: `co_${randomBytes(12).toString('hex')}`,
                device_id: input.device_id,
                account_key: input.account_key,
                intent_id: input.intent_id,
                idempotency_key: input.idempotency_key,
                request_digest: input.request_digest,
                status: 'DISPATCHING',
                created_at: now(),
                result: null,
            };
            state.operations.push(operation);
            return { duplicate: false, operation: { ...operation } };
        });
    }

    function finishOperation(operationId, status, result = null) {
        if (typeof operationId !== 'string' || !ID.test(operationId)
            || !['SUCCEEDED', 'FAILED', 'OUTCOME_UNKNOWN'].includes(status)) fail();
        const safeResult = {
            status,
            ...(Number.isInteger(result?.quantity) ? { quantity: result.quantity } : {}),
            ...(Number.isSafeInteger(result?.unit_price_krw) ? { unit_price_krw: result.unit_price_krw } : {}),
            ...(typeof result?.site_changed === 'boolean' ? { site_changed: result.site_changed } : {}),
            ...(typeof result?.order_created === 'boolean' ? { order_created: result.order_created } : {}),
            ...(typeof result?.verification_basis === 'string' && VERIFICATION_BASES.has(result.verification_basis)
                ? { verification_basis: result.verification_basis }
                : {}),
        };
        return transact((state) => {
            const operation = state.operations.find((item) => item.operation_id === operationId);
            if (!operation || operation.status !== 'DISPATCHING') fail();
            operation.status = status;
            operation.result = safeResult;
            operation.finished_at = now();
            return { ...operation };
        });
    }

    function recoverInterruptedOperations() {
        return transact((state) => {
            const recovered = [];
            for (const operation of state.operations) {
                if (operation.status !== 'DISPATCHING') continue;
                operation.status = 'OUTCOME_UNKNOWN';
                operation.result = { status: 'OUTCOME_UNKNOWN' };
                operation.finished_at = now();
                recovered.push(operation.operation_id);
            }
            return recovered;
        });
    }

    function findIntent(intentId, binding) {
        if (typeof intentId !== 'string' || !ID.test(intentId)) throw readError('INTENT_EXPIRED');
        const state = readState(io, directory);
        const intent = state.intents.find((item) => item.intent_id === intentId);
        if (!intent || intent.expires_at <= now()) throw readError('INTENT_EXPIRED');
        for (const key of ['device_id', 'epoch', 'mcp_session_id', 'session_id', 'worker_id', 'account_key']) {
            if (binding?.[key] !== intent[key]) throw readError('ACTION_DENIED');
        }
        return { ...intent };
    }

    return { saveIntent, claimOperation, finishOperation, recoverInterruptedOperations, findIntent };
}
