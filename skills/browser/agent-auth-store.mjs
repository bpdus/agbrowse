// @ts-check
/**
 * Persistent paired-device state and the explicit dev-only file key store.
 * Keychain storage is 확인 필요 and is not implemented.
 * This module never opens a network listener and never falls back to a file
 * key store unless the caller selects createDevFileKeyStore.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const AUTH_ERROR_MESSAGES = Object.freeze({
    PAIRING_CLOSED: 'Pairing is not open.',
    PAIRING_EXPIRED: 'Pairing request has expired.',
    AUTH_INVALID: 'Authentication was rejected.',
    AUTH_EXPIRED: 'Authentication has expired.',
    CHALLENGE_USED: 'Challenge was already used.',
    DEVICE_REVOKED: 'Device has been revoked.',
    SCOPE_DENIED: 'Requested scope was denied.',
    VERSION_UNSUPPORTED: 'Protocol version is not supported.',
    RATE_LIMITED: 'Rate limit was reached.',
    STATE_UNSAFE: 'Stored state is not safe to use.',
    KEY_UNAVAILABLE: 'Signing key is unavailable.',
});

const STATE_NAME = 'state.json';
const LOCK_NAME = '.writer.lock';
const SIGNING_KEY_ID = 'gateway-signing';
const STATE_KEYS = ['audience', 'devices', 'gateway_id', 'public_key', 'resource', 'revocations', 'signing_key_id', 'version'];
const DEVICE_KEYS = ['created_at', 'device_id', 'epoch', 'fingerprint', 'name', 'public_key', 'revoked', 'scopes'];
const REVOCATION_KEYS = ['device_id', 'epoch', 'revoked_at'];
const JWK_KEYS = ['crv', 'kty', 'x', 'y'];
const SCOPE_RE = /^[a-z0-9:._-]{1,64}$/;
const KEY_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const B64_32_RE = /^[A-Za-z0-9_-]{43}$/;

export class AgentAuthError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     */
    constructor(code, message) {
        super(message);
        this.name = 'AgentAuthError';
        this.code = code;
    }
}

/**
 * @param {keyof typeof AUTH_ERROR_MESSAGES} code
 * @returns {AgentAuthError}
 */
export function authError(code) {
    return new AgentAuthError(code, AUTH_ERROR_MESSAGES[code]);
}

/**
 * @param {unknown} error
 * @returns {AgentAuthError}
 */
function mapFs(error) {
    if (error instanceof AgentAuthError) return error;
    return authError('STATE_UNSAFE');
}

/**
 * @param {{ fs?: typeof fs } | null | undefined} options
 * @returns {typeof fs}
 */
function bindFs(options) {
    if (options?.fs === undefined) return fs;
    if (options.fs === null || typeof options.fs !== 'object') throw authError('STATE_UNSAFE');
    return options.fs;
}

/**
 * lstat every component. A symlink anywhere in the path is unsafe.
 * Ancestors must be real directories. The storage directory itself is
 * checked for owner and mode by assertOwnedDirectory.
 * @param {typeof fs} io
 * @param {string} resolved
 * @param {boolean} allowMissingFinal
 * @returns {fs.Stats | null}
 */
function assertStoragePath(io, resolved, allowMissingFinal) {
    const root = path.parse(resolved).root;
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || relative.split(path.sep).includes('..')) {
        throw authError('STATE_UNSAFE');
    }
    /** @type {fs.Stats} */
    let rootStat;
    try {
        rootStat = io.lstatSync(root);
    } catch (error) {
        throw mapFs(error);
    }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw authError('STATE_UNSAFE');
    const parts = relative.split(path.sep);
    let current = root;
    for (let index = 0; index < parts.length; index += 1) {
        current = path.join(current, parts[index]);
        const isFinal = index === parts.length - 1;
        /** @type {fs.Stats} */
        let stat;
        try {
            stat = io.lstatSync(current);
        } catch (error) {
            const code = /** @type {{ code?: string }} */ (error).code;
            if (code === 'ENOENT' && isFinal && allowMissingFinal) return null;
            throw mapFs(error);
        }
        if (stat.isSymbolicLink()) throw authError('STATE_UNSAFE');
        if (!isFinal && !stat.isDirectory()) throw authError('STATE_UNSAFE');
        if (isFinal) return stat;
    }
    throw authError('STATE_UNSAFE');
}

/**
 * @param {fs.Stats | null | undefined} stat
 */
function assertOwnedDirectory(stat) {
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid()) {
        throw authError('STATE_UNSAFE');
    }
    if ((stat.mode & 0o022) !== 0 || (stat.mode & 0o777) !== 0o700) throw authError('STATE_UNSAFE');
}

/**
 * @param {typeof fs} io
 * @param {string} directory
 */
function revalidateDirectory(io, directory) {
    assertOwnedDirectory(assertStoragePath(io, directory, false));
}

/**
 * @param {typeof fs} io
 * @param {string} directory
 * @returns {string}
 */
function prepareDirectory(io, directory) {
    if (typeof directory !== 'string' || directory.length === 0 || directory.includes('\0')) {
        throw authError('STATE_UNSAFE');
    }
    const resolved = path.resolve(directory);
    let stat = assertStoragePath(io, resolved, true);
    if (!stat) {
        try {
            io.mkdirSync(resolved, { mode: 0o700 });
            io.chmodSync(resolved, 0o700);
            stat = io.lstatSync(resolved);
        } catch (error) {
            throw mapFs(error);
        }
    }
    assertOwnedDirectory(stat);
    return resolved;
}

/**
 * @param {typeof fs} io
 * @param {string} directory
 * @returns {() => void}
 */
function acquireLock(io, directory) {
    revalidateDirectory(io, directory);
    const lockPath = path.join(directory, LOCK_NAME);
    let fd;
    try {
        fd = io.openSync(
            lockPath,
            io.constants.O_WRONLY | io.constants.O_CREAT | io.constants.O_EXCL | io.constants.O_NOFOLLOW,
            0o600,
        );
    } catch (error) {
        throw mapFs(error);
    }
    let released = false;
    return function release() {
        if (released) return;
        released = true;
        try { io.closeSync(fd); } catch { /* already closed */ }
        try {
            const stat = io.lstatSync(lockPath);
            if (!stat.isSymbolicLink()) io.unlinkSync(lockPath);
        } catch { /* lock file already gone */ }
    };
}

/**
 * @param {typeof fs} io
 * @param {string} directory
 */
function fsyncDirectory(io, directory) {
    const flags = io.constants.O_RDONLY | io.constants.O_DIRECTORY | io.constants.O_NOFOLLOW;
    const fd = io.openSync(directory, flags);
    try {
        io.fsyncSync(fd);
    } finally {
        io.closeSync(fd);
    }
}

/**
 * @param {typeof fs} io
 * @param {string} filePath
 */
function assertRegularFile(io, filePath) {
    let stat;
    try {
        stat = io.lstatSync(filePath);
    } catch (error) {
        const code = /** @type {{ code?: string }} */ (error).code;
        if (code === 'ENOENT') return null;
        throw mapFs(error);
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
        throw authError('STATE_UNSAFE');
    }
    return stat;
}

/**
 * @param {typeof fs} io
 * @param {string} directory
 * @param {string} filename
 * @param {Buffer | string} bytes
 */
function atomicWrite(io, directory, filename, bytes) {
    revalidateDirectory(io, directory);
    const finalPath = path.join(directory, filename);
    const tmpPath = path.join(directory, `.${filename}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    assertRegularFile(io, finalPath);
    let fd;
    try {
        fd = io.openSync(
            tmpPath,
            io.constants.O_WRONLY | io.constants.O_CREAT | io.constants.O_EXCL | io.constants.O_NOFOLLOW,
            0o600,
        );
        io.writeFileSync(fd, bytes);
        io.fsyncSync(fd);
    } catch (error) {
        if (fd !== undefined) {
            try { io.closeSync(fd); } catch { /* ignore */ }
        }
        try { io.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw mapFs(error);
    }
    io.closeSync(fd);
    let renamed = false;
    try {
        const tmpStat = io.lstatSync(tmpPath);
        if (tmpStat.isSymbolicLink() || (tmpStat.mode & 0o777) !== 0o600) {
            throw authError('STATE_UNSAFE');
        }
        io.renameSync(tmpPath, finalPath);
        renamed = true;
        fsyncDirectory(io, directory);
    } catch (error) {
        if (!renamed) {
            try { io.unlinkSync(tmpPath); } catch { /* already renamed or removed */ }
        }
        throw mapFs(error);
    }
    assertRegularFile(io, finalPath);
}

/**
 * @param {typeof fs} io
 * @param {string} filePath
 * @returns {Buffer}
 */
function readRegularFile(io, filePath) {
    revalidateDirectory(io, path.dirname(filePath));
    assertRegularFile(io, filePath);
    let fd;
    try {
        fd = io.openSync(filePath, io.constants.O_RDONLY | io.constants.O_NOFOLLOW);
        return io.readFileSync(fd);
    } catch (error) {
        throw mapFs(error);
    } finally {
        if (fd !== undefined) {
            try { io.closeSync(fd); } catch { /* ignore */ }
        }
    }
}

/**
 * @param {unknown} value
 * @param {string} code
 * @returns {{ kty: 'EC', crv: 'P-256', x: string, y: string }}
 */
export function parsePublicJwk(value, code) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw authError(/** @type {keyof typeof AUTH_ERROR_MESSAGES} */ (code));
    const record = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(record).sort();
    if (keys.some((key) => !JWK_KEYS.includes(key) && key !== 'alg')) {
        throw authError(/** @type {keyof typeof AUTH_ERROR_MESSAGES} */ (code));
    }
    if ('alg' in record && record.alg !== 'ES256') throw authError(/** @type {keyof typeof AUTH_ERROR_MESSAGES} */ (code));
    if (record.kty !== 'EC' || record.crv !== 'P-256') throw authError(/** @type {keyof typeof AUTH_ERROR_MESSAGES} */ (code));
    if (typeof record.x !== 'string' || typeof record.y !== 'string') throw authError(/** @type {keyof typeof AUTH_ERROR_MESSAGES} */ (code));
    if (!B64_32_RE.test(record.x) || !B64_32_RE.test(record.y)) throw authError(/** @type {keyof typeof AUTH_ERROR_MESSAGES} */ (code));
    const x = Buffer.from(record.x, 'base64url');
    const y = Buffer.from(record.y, 'base64url');
    if (x.length !== 32 || y.length !== 32 || x.toString('base64url') !== record.x || y.toString('base64url') !== record.y) {
        throw authError(/** @type {keyof typeof AUTH_ERROR_MESSAGES} */ (code));
    }
    return { kty: 'EC', crv: 'P-256', x: record.x, y: record.y };
}

/**
 * @param {{ x: string, y: string }} jwk
 * @returns {string}
 */
export function fingerprintPublicJwk(jwk) {
    const canonical = JSON.stringify({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y });
    return crypto.createHash('sha256').update(canonical).digest('base64url');
}

/**
 * @param {unknown} value
 * @param {string} code
 * @returns {string[]}
 */
function parseScopes(value, code) {
    if (!Array.isArray(value) || value.length > 32) throw authError(/** @type {keyof typeof AUTH_ERROR_MESSAGES} */ (code));
    /** @type {string[]} */
    const scopes = [];
    for (const scope of value) {
        if (typeof scope !== 'string' || !SCOPE_RE.test(scope) || scopes.includes(scope)) {
            throw authError(/** @type {keyof typeof AUTH_ERROR_MESSAGES} */ (code));
        }
        scopes.push(scope);
    }
    const sorted = scopes.slice().sort();
    if (sorted.some((scope, index) => scope !== scopes[index])) throw authError(/** @type {keyof typeof AUTH_ERROR_MESSAGES} */ (code));
    return scopes;
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function assertStateShape(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw authError('STATE_UNSAFE');
    const record = /** @type {Record<string, unknown>} */ (value);
    const keys = Object.keys(record).sort();
    if (keys.length !== STATE_KEYS.length || keys.some((key, index) => key !== STATE_KEYS[index])) {
        if (typeof record.version === 'number' && Number.isInteger(record.version) && record.version !== 1) {
            throw authError('VERSION_UNSUPPORTED');
        }
        throw authError('STATE_UNSAFE');
    }
    if (record.version !== 1) throw authError('VERSION_UNSUPPORTED');
    if (record.signing_key_id !== SIGNING_KEY_ID) throw authError('STATE_UNSAFE');
    for (const field of ['gateway_id', 'audience', 'resource']) {
        if (typeof record[field] !== 'string' || record[field].length === 0 || record[field].length > 512) {
            throw authError('STATE_UNSAFE');
        }
    }
    const publicKey = parsePublicJwk(record.public_key, 'STATE_UNSAFE');
    if (record.devices === null || typeof record.devices !== 'object' || Array.isArray(record.devices)) {
        throw authError('STATE_UNSAFE');
    }
    if (!Array.isArray(record.revocations)) throw authError('STATE_UNSAFE');
    const devices = /** @type {Record<string, unknown>} */ (record.devices);
    for (const [deviceId, deviceValue] of Object.entries(devices)) {
        if (deviceValue === null || typeof deviceValue !== 'object' || Array.isArray(deviceValue)) throw authError('STATE_UNSAFE');
        const device = /** @type {Record<string, unknown>} */ (deviceValue);
        const deviceKeys = Object.keys(device).sort();
        if (deviceKeys.length !== DEVICE_KEYS.length || deviceKeys.some((key, index) => key !== DEVICE_KEYS[index])) {
            throw authError('STATE_UNSAFE');
        }
        if (device.device_id !== deviceId || typeof device.name !== 'string' || device.name.length === 0 || device.name.length > 64) {
            throw authError('STATE_UNSAFE');
        }
        const deviceKey = parsePublicJwk(device.public_key, 'STATE_UNSAFE');
        if (device.fingerprint !== fingerprintPublicJwk(deviceKey)) throw authError('STATE_UNSAFE');
        parseScopes(device.scopes, 'STATE_UNSAFE');
        if (!Number.isSafeInteger(device.epoch) || /** @type {number} */ (device.epoch) < 1) throw authError('STATE_UNSAFE');
        if (typeof device.revoked !== 'boolean') throw authError('STATE_UNSAFE');
        if (!Number.isSafeInteger(device.created_at)) throw authError('STATE_UNSAFE');
    }
    for (const entryValue of record.revocations) {
        if (entryValue === null || typeof entryValue !== 'object' || Array.isArray(entryValue)) throw authError('STATE_UNSAFE');
        const entry = /** @type {Record<string, unknown>} */ (entryValue);
        const entryKeys = Object.keys(entry).sort();
        if (entryKeys.length !== REVOCATION_KEYS.length || entryKeys.some((key, index) => key !== REVOCATION_KEYS[index])) {
            throw authError('STATE_UNSAFE');
        }
        if (typeof entry.device_id !== 'string' || !(entry.device_id in devices)) throw authError('STATE_UNSAFE');
        if (!Number.isSafeInteger(entry.epoch) || !Number.isSafeInteger(entry.revoked_at)) throw authError('STATE_UNSAFE');
        const device = /** @type {{ revoked: boolean, epoch: number }} */ (devices[/** @type {string} */ (entry.device_id)]);
        if (!device.revoked || device.epoch !== entry.epoch) throw authError('STATE_UNSAFE');
    }
    record.public_key = publicKey;
    return record;
}

/**
 * @param {{ directory: string, fs?: typeof fs }} options
 */
export function createJsonStateStore(options) {
    const io = bindFs(options);
    const directory = prepareDirectory(io, options?.directory);
    const release = acquireLock(io, directory);
    const statePath = path.join(directory, STATE_NAME);
    let closed = false;
    try {
        if (io.existsSync(statePath) || io.lstatSync(statePath, { throwIfNoEntry: false })) {
            assertRegularFile(io, statePath);
        }
    } catch (error) {
        release();
        throw error;
    }

    return {
        load() {
            if (closed) throw authError('STATE_UNSAFE');
            revalidateDirectory(io, directory);
            if (!io.existsSync(statePath)) return null;
            const bytes = readRegularFile(io, statePath);
            /** @type {unknown} */
            let parsed;
            try {
                parsed = JSON.parse(bytes.toString('utf8'));
            } catch {
                throw authError('STATE_UNSAFE');
            }
            return assertStateShape(parsed);
        },
        /**
         * @param {unknown} state
         */
        save(state) {
            if (closed) throw authError('STATE_UNSAFE');
            const checked = assertStateShape(state);
            const bytes = Buffer.from(`${JSON.stringify(checked)}\n`, 'utf8');
            atomicWrite(io, directory, STATE_NAME, bytes);
            const written = readRegularFile(io, statePath);
            if (!written.equals(bytes)) throw authError('STATE_UNSAFE');
        },
        close() {
            if (closed) return;
            closed = true;
            release();
        },
    };
}

/**
 * Explicit dev-only P-256 key store. Production Keychain storage is 확인 필요.
 * Callers must opt in. Unavailable production storage must not call this factory.
 * @param {{ directory: string, fs?: typeof fs }} options
 */
export function createDevFileKeyStore(options) {
    const io = bindFs(options);
    const directory = prepareDirectory(io, options?.directory);
    const release = acquireLock(io, directory);
    let closed = false;

    /**
     * @param {string} keyId
     */
    function keyPath(keyId) {
        if (!KEY_ID_RE.test(keyId)) throw authError('STATE_UNSAFE');
        return path.join(directory, `${keyId}.pem`);
    }

    /**
     * @param {string} keyId
     * @param {boolean} required
     */
    function loadPrivate(keyId, required) {
        if (closed) throw authError('STATE_UNSAFE');
        const filePath = keyPath(keyId);
        let exists = false;
        try {
            exists = io.existsSync(filePath);
        } catch {
            throw authError('KEY_UNAVAILABLE');
        }
        if (!exists) {
            if (required) throw authError('KEY_UNAVAILABLE');
            return null;
        }
        let pem;
        try {
            pem = readRegularFile(io, filePath);
        } catch (error) {
            if (error instanceof AgentAuthError && error.code === 'STATE_UNSAFE') throw error;
            throw authError('KEY_UNAVAILABLE');
        }
        try {
            const key = crypto.createPrivateKey(pem);
            if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
                throw authError('KEY_UNAVAILABLE');
            }
            return key;
        } catch (error) {
            if (error instanceof AgentAuthError) throw error;
            throw authError('KEY_UNAVAILABLE');
        }
    }

    /**
     * @param {crypto.KeyObject} privateKey
     */
    function publicJwk(privateKey) {
        const exported = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
        return parsePublicJwk(exported, 'KEY_UNAVAILABLE');
    }

    return {
        /**
         * @param {string} keyId
         */
        ensureKey(keyId) {
            const existing = loadPrivate(keyId, false);
            if (existing) return publicJwk(existing);
            const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
            const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
            atomicWrite(io, directory, `${keyId}.pem`, pem);
            return publicJwk(/** @type {crypto.KeyObject} */ (loadPrivate(keyId, true)));
        },
        /**
         * @param {string} keyId
         */
        getPublicKey(keyId) {
            return publicJwk(/** @type {crypto.KeyObject} */ (loadPrivate(keyId, true)));
        },
        /**
         * @param {string} keyId
         * @param {Buffer} bytes
         * @returns {Buffer}
         */
        sign(keyId, bytes) {
            if (!Buffer.isBuffer(bytes)) throw authError('KEY_UNAVAILABLE');
            const privateKey = /** @type {crypto.KeyObject} */ (loadPrivate(keyId, true));
            const signature = crypto.sign('sha256', bytes, { key: privateKey, dsaEncoding: 'ieee-p1363' });
            if (signature.length !== 64) throw authError('KEY_UNAVAILABLE');
            return signature;
        },
        close() {
            if (closed) return;
            closed = true;
            release();
        },
    };
}

export const GATEWAY_SIGNING_KEY_ID = SIGNING_KEY_ID;
