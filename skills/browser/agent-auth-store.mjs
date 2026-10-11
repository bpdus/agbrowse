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
 * @param {string} directory
 * @returns {string}
 */
function prepareDirectory(directory) {
    if (typeof directory !== 'string' || directory.length === 0 || directory.includes('\0')) {
        throw authError('STATE_UNSAFE');
    }
    const resolved = path.resolve(directory);
    /** @type {fs.Stats} */
    let stat;
    try {
        stat = fs.lstatSync(resolved);
    } catch (error) {
        const code = /** @type {{ code?: string }} */ (error).code;
        if (code !== 'ENOENT') throw mapFs(error);
        try {
            fs.mkdirSync(resolved, { mode: 0o700 });
            fs.chmodSync(resolved, 0o700);
            stat = fs.lstatSync(resolved);
        } catch (mkdirError) {
            throw mapFs(mkdirError);
        }
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700) {
        throw authError('STATE_UNSAFE');
    }
    return resolved;
}

/**
 * @param {string} directory
 * @returns {() => void}
 */
function acquireLock(directory) {
    const lockPath = path.join(directory, LOCK_NAME);
    let fd;
    try {
        fd = fs.openSync(
            lockPath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
            0o600,
        );
    } catch (error) {
        throw mapFs(error);
    }
    let released = false;
    return function release() {
        if (released) return;
        released = true;
        try { fs.closeSync(fd); } catch { /* already closed */ }
        try {
            const stat = fs.lstatSync(lockPath);
            if (!stat.isSymbolicLink()) fs.unlinkSync(lockPath);
        } catch { /* lock file already gone */ }
    };
}

/**
 * @param {string} directory
 */
function fsyncDirectory(directory) {
    const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
    const fd = fs.openSync(directory, flags);
    try {
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * @param {string} filePath
 */
function assertRegularFile(filePath) {
    let stat;
    try {
        stat = fs.lstatSync(filePath);
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
 * @param {string} directory
 * @param {string} filename
 * @param {Buffer | string} bytes
 */
function atomicWrite(directory, filename, bytes) {
    const finalPath = path.join(directory, filename);
    const tmpPath = path.join(directory, `.${filename}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    assertRegularFile(finalPath);
    let fd;
    try {
        fd = fs.openSync(
            tmpPath,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
            0o600,
        );
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
    } catch (error) {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* ignore */ }
        }
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw mapFs(error);
    }
    fs.closeSync(fd);
    try {
        const tmpStat = fs.lstatSync(tmpPath);
        if (tmpStat.isSymbolicLink() || (tmpStat.mode & 0o777) !== 0o600) {
            throw authError('STATE_UNSAFE');
        }
        fs.renameSync(tmpPath, finalPath);
        fsyncDirectory(directory);
    } catch (error) {
        try { fs.unlinkSync(tmpPath); } catch { /* already renamed or removed */ }
        throw mapFs(error);
    }
    assertRegularFile(finalPath);
}

/**
 * @param {string} filePath
 * @returns {Buffer}
 */
function readRegularFile(filePath) {
    assertRegularFile(filePath);
    let fd;
    try {
        fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        return fs.readFileSync(fd);
    } catch (error) {
        throw mapFs(error);
    } finally {
        if (fd !== undefined) {
            try { fs.closeSync(fd); } catch { /* ignore */ }
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
 * @param {{ directory: string }} options
 */
export function createJsonStateStore(options) {
    const directory = prepareDirectory(options?.directory);
    const release = acquireLock(directory);
    const statePath = path.join(directory, STATE_NAME);
    let closed = false;
    try {
        if (fs.existsSync(statePath) || fs.lstatSync(statePath, { throwIfNoEntry: false })) {
            assertRegularFile(statePath);
        }
    } catch (error) {
        release();
        throw error;
    }

    return {
        load() {
            if (closed) throw authError('STATE_UNSAFE');
            if (!fs.existsSync(statePath)) return null;
            const bytes = readRegularFile(statePath);
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
            atomicWrite(directory, STATE_NAME, bytes);
            const written = readRegularFile(statePath);
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
 * @param {{ directory: string }} options
 */
export function createDevFileKeyStore(options) {
    const directory = prepareDirectory(options?.directory);
    const release = acquireLock(directory);
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
            exists = fs.existsSync(filePath);
        } catch {
            throw authError('KEY_UNAVAILABLE');
        }
        if (!exists) {
            if (required) throw authError('KEY_UNAVAILABLE');
            return null;
        }
        let pem;
        try {
            pem = readRegularFile(filePath);
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
            try {
                atomicWrite(directory, `${keyId}.pem`, pem);
            } catch (error) {
                if (loadPrivate(keyId, false)) return publicJwk(/** @type {crypto.KeyObject} */ (loadPrivate(keyId, true)));
                throw error;
            }
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
