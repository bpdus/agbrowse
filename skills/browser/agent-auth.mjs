// @ts-check
/**
 * paired-device-v1 pairing, ES256 proof exchange, access tokens, and renewal.
 * Importing this module does not open a socket.
 * Operator pairing and revocation stay in-process. Nothing here is logged.
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import {
    AUTH_ERROR_MESSAGES,
    AgentAuthError,
    GATEWAY_SIGNING_KEY_ID,
    authError,
    fingerprintPublicJwk,
    parsePublicJwk,
} from './agent-auth-store.mjs';

export { AUTH_ERROR_MESSAGES, AgentAuthError, authError };

export const AUTH_LIMITS = Object.freeze({
    protocolVersion: '0.1.0',
    purpose: 'paired-device-v1',
    pairingTtlSeconds: 120,
    challengeTtlSeconds: 30,
    tokenTtlSeconds: 300,
    renewAfterSeconds: 240,
    maxIatSkewSeconds: 30,
    maxPending: 32,
    maxAttempts: 5,
    maxChallenges: 32,
    maxIssuesPerWindow: 30,
    issueWindowSeconds: 60,
    bodyBytes: 16 * 1024,
});

const CHALLENGE_HEADER_JSON = '{"alg":"ES256","typ":"paired-device-v1+challenge"}';
const ACCESS_HEADER_JSON = '{"alg":"ES256","typ":"paired-device-v1+access"}';
const SCOPE_RE = /^[a-z0-9:._-]{1,64}$/;
const GATEWAY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const FATAL_RENEWAL = new Set([
    'DEVICE_REVOKED',
    'AUTH_INVALID',
    'AUTH_EXPIRED',
    'CHALLENGE_USED',
    'SCOPE_DENIED',
    'KEY_UNAVAILABLE',
    'STATE_UNSAFE',
    'VERSION_UNSUPPORTED',
    'PAIRING_CLOSED',
    'PAIRING_EXPIRED',
]);

/**
 * @param {() => number} [now]
 * @returns {number}
 */
function epochSeconds(now) {
    const value = now ? now() : Date.now();
    if (!Number.isFinite(value)) throw authError('AUTH_INVALID');
    return Math.floor(value / 1000);
}

/**
 * @param {string} prefix
 * @returns {string}
 */
function newId(prefix) {
    return `${prefix}${crypto.randomBytes(16).toString('base64url')}`;
}

/**
 * @returns {string}
 */
function confirmationCode() {
    const bytes = crypto.randomBytes(8);
    let code = '';
    for (const byte of bytes) code += CODE_ALPHABET[byte & 31];
    return code;
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function safeEqual(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * @param {unknown} value
 * @param {boolean} allowEmpty
 * @returns {string[]}
 */
function normalizeScopes(value, allowEmpty) {
    if (!Array.isArray(value) || value.length > 32) throw authError('SCOPE_DENIED');
    /** @type {string[]} */
    const scopes = [];
    for (const scope of value) {
        if (typeof scope !== 'string' || !SCOPE_RE.test(scope)) throw authError('SCOPE_DENIED');
        if (!scopes.includes(scope)) scopes.push(scope);
    }
    scopes.sort();
    if (!allowEmpty && scopes.length === 0) throw authError('SCOPE_DENIED');
    return scopes;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function parseText(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 512) throw authError('AUTH_INVALID');
    if (/[\s\u0000-\u001f\u007f]/.test(value)) throw authError('AUTH_INVALID');
    return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function parseName(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 64) throw authError('AUTH_INVALID');
    if (/[\u0000-\u001f\u007f]/.test(value)) throw authError('AUTH_INVALID');
    return value;
}

/**
 * @param {string} segment
 * @param {number} max
 * @returns {Buffer | null}
 */
function decodeB64Url(segment, max) {
    if (typeof segment !== 'string' || segment.length === 0 || segment.length > max) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
    const bytes = Buffer.from(segment, 'base64url');
    if (bytes.toString('base64url') !== segment) return null;
    return bytes;
}

/**
 * @param {unknown} fields
 * @returns {Buffer}
 */
export function encodeChallengePayload(fields) {
    const record = /** @type {Record<string, unknown>} */ (fields);
    const scopes = normalizeScopes(record.requested_scopes, false);
    const nonce = record.nonce;
    if (typeof nonce !== 'string' || decodeB64Url(nonce, 64)?.length !== 32) throw authError('AUTH_INVALID');
    for (const key of ['gateway_id', 'aud', 'device_id', 'challenge_id', 'resource']) {
        if (typeof record[key] !== 'string' || record[key].length === 0) throw authError('AUTH_INVALID');
    }
    for (const key of ['iat', 'exp']) {
        if (!Number.isSafeInteger(record[key])) throw authError('AUTH_INVALID');
    }
    if (record.protocol_version !== AUTH_LIMITS.protocolVersion) throw authError('VERSION_UNSUPPORTED');
    if (record.purpose !== AUTH_LIMITS.purpose) throw authError('AUTH_INVALID');
    if (record.expires_in !== AUTH_LIMITS.challengeTtlSeconds) throw authError('AUTH_INVALID');
    if (record.exp !== /** @type {number} */ (record.iat) + AUTH_LIMITS.challengeTtlSeconds) throw authError('AUTH_INVALID');
    return Buffer.from(JSON.stringify({
        protocol_version: AUTH_LIMITS.protocolVersion,
        purpose: AUTH_LIMITS.purpose,
        gateway_id: record.gateway_id,
        aud: record.aud,
        device_id: record.device_id,
        challenge_id: record.challenge_id,
        nonce,
        resource: record.resource,
        requested_scopes: scopes,
        iat: record.iat,
        exp: record.exp,
        expires_in: AUTH_LIMITS.challengeTtlSeconds,
    }), 'utf8');
}

/**
 * @param {unknown} claims
 * @returns {Buffer}
 */
export function encodeAccessClaims(claims) {
    const record = /** @type {Record<string, unknown>} */ (claims);
    const scope = normalizeScopes(record.scope, true);
    for (const key of ['iss', 'aud', 'sub', 'device_id', 'jti']) {
        if (typeof record[key] !== 'string' || record[key].length === 0 || record[key].length > 512) {
            throw authError('AUTH_INVALID');
        }
    }
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(/** @type {string} */ (record.jti))) throw authError('AUTH_INVALID');
    if (record.sub !== record.device_id) throw authError('AUTH_INVALID');
    for (const key of ['iat', 'exp', 'device_epoch']) {
        if (!Number.isSafeInteger(record[key])) throw authError('AUTH_INVALID');
    }
    if (/** @type {number} */ (record.device_epoch) < 1) throw authError('AUTH_INVALID');
    if (record.exp !== /** @type {number} */ (record.iat) + AUTH_LIMITS.tokenTtlSeconds) throw authError('AUTH_INVALID');
    return Buffer.from(JSON.stringify({
        iss: record.iss,
        aud: record.aud,
        sub: record.sub,
        device_id: record.device_id,
        scope,
        iat: record.iat,
        exp: record.exp,
        jti: record.jti,
        device_epoch: record.device_epoch,
    }), 'utf8');
}

/**
 * @param {{ sign: (keyId: string, bytes: Buffer) => Buffer }} keyStore
 * @param {string} keyId
 * @param {string} headerJson
 * @param {Buffer} payloadBytes
 * @returns {string}
 */
export function signCompactJws(keyStore, keyId, headerJson, payloadBytes) {
    const headerPart = Buffer.from(headerJson, 'utf8').toString('base64url');
    const payloadPart = payloadBytes.toString('base64url');
    const signingInput = Buffer.from(`${headerPart}.${payloadPart}`, 'utf8');
    const signature = keyStore.sign(keyId, signingInput);
    if (!Buffer.isBuffer(signature) || signature.length !== 64) throw authError('KEY_UNAVAILABLE');
    return `${headerPart}.${payloadPart}.${signature.toString('base64url')}`;
}

/**
 * @param {string} token
 * @param {string} headerJson
 * @param {{ kty: 'EC', crv: 'P-256', x: string, y: string }} publicKey
 * @returns {Buffer}
 */
function verifiedPayload(token, headerJson, publicKey) {
    if (typeof token !== 'string') throw authError('AUTH_INVALID');
    const parts = token.split('.');
    if (parts.length !== 3) throw authError('AUTH_INVALID');
    const header = decodeB64Url(parts[0], 256);
    const payload = decodeB64Url(parts[1], 8192);
    const signature = decodeB64Url(parts[2], 128);
    if (!header || !payload || !signature || signature.length !== 64) throw authError('AUTH_INVALID');
    if (!header.equals(Buffer.from(headerJson, 'utf8'))) throw authError('AUTH_INVALID');
    let key;
    try {
        key = crypto.createPublicKey({ key: publicKey, format: 'jwk' });
    } catch {
        throw authError('KEY_UNAVAILABLE');
    }
    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
    const ok = crypto.verify('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' }, signature);
    if (!ok) throw authError('AUTH_INVALID');
    return payload;
}

/**
 * @param {Buffer} payload
 * @returns {Record<string, unknown>}
 */
function parseExactJson(payload) {
    /** @type {unknown} */
    let parsed;
    try {
        parsed = JSON.parse(payload.toString('utf8'));
    } catch {
        throw authError('AUTH_INVALID');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw authError('AUTH_INVALID');
    return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * @returns {(task: () => unknown) => Promise<unknown>}
 */
function createQueue() {
    let tail = Promise.resolve();
    return function enqueue(task) {
        const run = tail.then(task);
        tail = run.then(() => undefined, () => undefined);
        return run;
    };
}

/**
 * @param {{
 *   stateStore: { load: () => any, save: (state: any) => void, close?: () => void },
 *   keyStore: { ensureKey: (keyId: string) => any, getPublicKey: (keyId: string) => any, sign: (keyId: string, bytes: Buffer) => Buffer, close?: () => void },
 *   gatewayId: string,
 *   audience: string,
 *   resource?: string,
 *   now?: () => number,
 * }} options
 */
export function createAuthService(options) {
    if (!options?.stateStore || !options.keyStore) throw authError('KEY_UNAVAILABLE');
    const gatewayId = options.gatewayId;
    if (typeof gatewayId !== 'string' || !GATEWAY_ID_RE.test(gatewayId)) throw authError('AUTH_INVALID');
    const audience = parseText(options.audience);
    const resource = options.resource === undefined ? audience : parseText(options.resource);
    const now = options.now ?? Date.now;
    const enqueue = createQueue();
    /** @type {Record<string, any> | null} */
    let state = null;
    /** @type {Map<string, { window_id: string, expires_at: number, closed: boolean }>} */
    const windows = new Map();
    /** @type {Map<string, any>} */
    const pendings = new Map();
    /** @type {Map<string, { device_id: string, bytes: Buffer, exp: number }>} */
    const challenges = new Map();
    /** @type {Map<string, number[]>} */
    const issueTimes = new Map();
    const usedChallenges = new Set();
    const expiredChallenges = new Set();
    let closed = false;

    function assertOpen() {
        if (closed) throw authError('STATE_UNSAFE');
    }

    function seconds() {
        return epochSeconds(now);
    }

    function ensureIdentity() {
        assertOpen();
        if (state) return;
        const loaded = options.stateStore.load();
        if (loaded == null) {
            options.keyStore.ensureKey(GATEWAY_SIGNING_KEY_ID);
            const publicKey = parsePublicJwk(options.keyStore.getPublicKey(GATEWAY_SIGNING_KEY_ID), 'KEY_UNAVAILABLE');
            const fresh = {
                version: 1,
                gateway_id: gatewayId,
                audience,
                resource,
                signing_key_id: GATEWAY_SIGNING_KEY_ID,
                public_key: publicKey,
                devices: {},
                revocations: [],
            };
            options.stateStore.save(fresh);
            state = fresh;
            return;
        }
        if (loaded.gateway_id !== gatewayId || loaded.audience !== audience || loaded.resource !== resource) {
            throw authError('STATE_UNSAFE');
        }
        const publicKey = parsePublicJwk(options.keyStore.getPublicKey(GATEWAY_SIGNING_KEY_ID), 'KEY_UNAVAILABLE');
        if (publicKey.x !== loaded.public_key.x || publicKey.y !== loaded.public_key.y || publicKey.crv !== loaded.public_key.crv) {
            throw authError('KEY_UNAVAILABLE');
        }
        state = loaded;
    }

    /**
     * @param {number} at
     */
    function openWindow(at) {
        let expired = false;
        /** @type {{ window_id: string, expires_at: number, closed: boolean } | null} */
        let chosen = null;
        for (const window of windows.values()) {
            if (window.closed) continue;
            if (at >= window.expires_at) {
                expired = true;
                continue;
            }
            chosen = window;
        }
        if (chosen) return chosen;
        if (expired) throw authError('PAIRING_EXPIRED');
        throw authError('PAIRING_CLOSED');
    }

    function purgePending(at) {
        for (const [id, pending] of pendings) {
            if (at >= pending.expires_at) pendings.delete(id);
        }
    }

    function purgeChallenges(at) {
        for (const [id, challenge] of challenges) {
            if (at >= challenge.exp) {
                challenges.delete(id);
                expiredChallenges.add(id);
            }
        }
    }

    /**
     * @param {string} deviceId
     * @param {number} at
     */
    function assertIssueRate(deviceId, at) {
        const fresh = (issueTimes.get(deviceId) ?? []).filter((stamp) => at - stamp < AUTH_LIMITS.issueWindowSeconds);
        if (fresh.length >= AUTH_LIMITS.maxIssuesPerWindow) throw authError('RATE_LIMITED');
        fresh.push(at);
        issueTimes.set(deviceId, fresh);
    }

    /**
     * @returns {{ window_id: string, expires_at: number, expires_in: number }}
     */
    function openPairingWindow() {
        ensureIdentity();
        const at = seconds();
        const window = {
            window_id: newId('win_'),
            expires_at: at + AUTH_LIMITS.pairingTtlSeconds,
            closed: false,
        };
        windows.set(window.window_id, window);
        return { window_id: window.window_id, expires_at: window.expires_at, expires_in: AUTH_LIMITS.pairingTtlSeconds };
    }

    /**
     * @param {string} windowId
     */
    function closePairingWindow(windowId) {
        assertOpen();
        const window = windows.get(windowId);
        if (!window) throw authError('PAIRING_CLOSED');
        window.closed = true;
        return { window_id: windowId, closed: true };
    }

    /**
     * @param {{ publicKey: unknown, name: unknown, requestedScopes: unknown }} input
     */
    function submitPairing(input) {
        ensureIdentity();
        const at = seconds();
        const window = openWindow(at);
        purgePending(at);
        if (pendings.size >= AUTH_LIMITS.maxPending) throw authError('RATE_LIMITED');
        const publicKey = parsePublicJwk(input?.publicKey, 'AUTH_INVALID');
        const name = parseName(input?.name);
        const requestedScopes = normalizeScopes(input?.requestedScopes, false);
        const pending = {
            pending_id: newId('pend_'),
            window_id: window.window_id,
            public_key: publicKey,
            name,
            requested_scopes: requestedScopes,
            fingerprint: fingerprintPublicJwk(publicKey),
            confirmation_code: confirmationCode(),
            expires_at: window.expires_at,
            attempts: 0,
        };
        pendings.set(pending.pending_id, pending);
        return {
            protocol_version: AUTH_LIMITS.protocolVersion,
            pending_id: pending.pending_id,
            fingerprint: pending.fingerprint,
            confirmation_code: pending.confirmation_code,
            expires_at: pending.expires_at,
            expires_in: pending.expires_at - at,
        };
    }

    /**
     * @param {string} pendingId
     */
    function inspectPairing(pendingId) {
        assertOpen();
        const pending = pendings.get(pendingId);
        if (!pending) throw authError('AUTH_INVALID');
        if (seconds() >= pending.expires_at) throw authError('PAIRING_EXPIRED');
        return {
            pending_id: pending.pending_id,
            window_id: pending.window_id,
            fingerprint: pending.fingerprint,
            confirmation_code: pending.confirmation_code,
            name: pending.name,
            requested_scopes: pending.requested_scopes.slice(),
            public_key: { ...pending.public_key },
            expires_at: pending.expires_at,
        };
    }

    /**
     * @param {{ pendingId: string, code: string, fingerprint: string, grantedScopes: unknown }} input
     */
    function confirmPairing(input) {
        ensureIdentity();
        const pending = pendings.get(input?.pendingId);
        if (!pending) throw authError('AUTH_INVALID');
        const at = seconds();
        const window = windows.get(pending.window_id);
        if (!window) throw authError('PAIRING_CLOSED');
        if (window.closed) throw authError('PAIRING_CLOSED');
        if (at >= pending.expires_at || at >= window.expires_at) throw authError('PAIRING_EXPIRED');
        if (pending.attempts >= AUTH_LIMITS.maxAttempts) throw authError('AUTH_INVALID');
        if (!safeEqual(input?.code, pending.confirmation_code) || !safeEqual(input?.fingerprint, pending.fingerprint)) {
            pending.attempts += 1;
            throw authError('AUTH_INVALID');
        }
        const granted = normalizeScopes(input?.grantedScopes, true);
        if (granted.some((scope) => !pending.requested_scopes.includes(scope))) throw authError('SCOPE_DENIED');
        const deviceId = newId('dev_');
        const next = structuredClone(state);
        next.devices[deviceId] = {
            device_id: deviceId,
            name: pending.name,
            public_key: pending.public_key,
            fingerprint: pending.fingerprint,
            scopes: granted,
            epoch: 1,
            revoked: false,
            created_at: at,
        };
        options.stateStore.save(next);
        state = next;
        pendings.delete(pending.pending_id);
        return {
            device_id: deviceId,
            epoch: 1,
            server: {
                gateway_id: gatewayId,
                audience,
                resource,
                public_key: { .../** @type {Record<string, any>} */ (state).public_key },
            },
        };
    }

    /**
     * @param {{ deviceId: string, resource?: string, requestedScopes: unknown }} input
     */
    function issueChallenge(input) {
        ensureIdentity();
        const at = seconds();
        const device = /** @type {Record<string, any>} */ (state).devices[input?.deviceId];
        if (!device) throw authError('AUTH_INVALID');
        if (device.revoked) throw authError('DEVICE_REVOKED');
        if (input.resource !== undefined && input.resource !== resource) throw authError('AUTH_INVALID');
        const requestedScopes = normalizeScopes(input?.requestedScopes, false);
        if (requestedScopes.some((scope) => !device.scopes.includes(scope))) throw authError('SCOPE_DENIED');
        purgeChallenges(at);
        if (challenges.size >= AUTH_LIMITS.maxChallenges) throw authError('RATE_LIMITED');
        assertIssueRate(device.device_id, at);
        const challengeId = newId('ch_');
        const bytes = encodeChallengePayload({
            protocol_version: AUTH_LIMITS.protocolVersion,
            purpose: AUTH_LIMITS.purpose,
            gateway_id: gatewayId,
            aud: audience,
            device_id: device.device_id,
            challenge_id: challengeId,
            nonce: crypto.randomBytes(32).toString('base64url'),
            resource,
            requested_scopes: requestedScopes,
            iat: at,
            exp: at + AUTH_LIMITS.challengeTtlSeconds,
            expires_in: AUTH_LIMITS.challengeTtlSeconds,
        });
        challenges.set(challengeId, { device_id: device.device_id, bytes, exp: at + AUTH_LIMITS.challengeTtlSeconds });
        return {
            protocol_version: AUTH_LIMITS.protocolVersion,
            challenge_id: challengeId,
            payload: bytes.toString('base64url'),
            expires_in: AUTH_LIMITS.challengeTtlSeconds,
        };
    }

    /**
     * @param {{ challengeId: string, deviceId: string, proof: string }} input
     */
    function exchangeProof(input) {
        ensureIdentity();
        const at = seconds();
        const device = /** @type {Record<string, any>} */ (state).devices[input?.deviceId];
        if (!device) throw authError('AUTH_INVALID');
        if (device.revoked) throw authError('DEVICE_REVOKED');
        const challengeId = input.challengeId;
        if (usedChallenges.has(challengeId)) throw authError('CHALLENGE_USED');
        const challenge = challenges.get(challengeId);
        if (!challenge) {
            if (expiredChallenges.has(challengeId)) throw authError('AUTH_EXPIRED');
            throw authError('AUTH_INVALID');
        }
        if (challenge.device_id !== device.device_id) throw authError('AUTH_INVALID');
        if (at >= challenge.exp) {
            challenges.delete(challengeId);
            expiredChallenges.add(challengeId);
            throw authError('AUTH_EXPIRED');
        }
        const payload = verifiedPayload(input.proof, CHALLENGE_HEADER_JSON, device.public_key);
        if (!payload.equals(challenge.bytes)) throw authError('AUTH_INVALID');
        challenges.delete(challengeId);
        usedChallenges.add(challengeId);
        if (usedChallenges.size > 1024) {
            const oldest = usedChallenges.values().next().value;
            if (oldest) usedChallenges.delete(oldest);
        }
        const issuedAt = seconds();
        const claims = encodeAccessClaims({
            iss: gatewayId,
            aud: audience,
            sub: device.device_id,
            device_id: device.device_id,
            scope: parseExactJson(challenge.bytes).requested_scopes,
            iat: issuedAt,
            exp: issuedAt + AUTH_LIMITS.tokenTtlSeconds,
            jti: newId('jti_'),
            device_epoch: device.epoch,
        });
        const token = signCompactJws(options.keyStore, GATEWAY_SIGNING_KEY_ID, ACCESS_HEADER_JSON, claims);
        return {
            protocol_version: AUTH_LIMITS.protocolVersion,
            token,
            token_type: 'Bearer',
            expires_in: AUTH_LIMITS.tokenTtlSeconds,
        };
    }

    /**
     * @param {string} token
     */
    function authenticate(token) {
        ensureIdentity();
        const at = seconds();
        const publicKey = /** @type {Record<string, any>} */ (state).public_key;
        const payload = verifiedPayload(token, ACCESS_HEADER_JSON, publicKey);
        const parsed = parseExactJson(payload);
        let canonical;
        try {
            canonical = encodeAccessClaims(parsed);
        } catch (error) {
            if (error instanceof AgentAuthError) throw authError('AUTH_INVALID');
            throw authError('AUTH_INVALID');
        }
        if (!canonical.equals(payload)) throw authError('AUTH_INVALID');
        if (parsed.iss !== gatewayId || parsed.aud !== audience) throw authError('AUTH_INVALID');
        const device = /** @type {Record<string, any>} */ (state).devices[/** @type {string} */ (parsed.device_id)];
        if (!device) throw authError('AUTH_INVALID');
        if (device.revoked) throw authError('DEVICE_REVOKED');
        if (parsed.device_epoch !== device.epoch) throw authError('AUTH_INVALID');
        const iat = /** @type {number} */ (parsed.iat);
        const exp = /** @type {number} */ (parsed.exp);
        if (iat > at + AUTH_LIMITS.maxIatSkewSeconds) throw authError('AUTH_INVALID');
        if (at >= exp) throw authError('AUTH_EXPIRED');
        const tokenScopes = /** @type {string[]} */ (parsed.scope);
        const scopes = tokenScopes.filter((scope) => device.scopes.includes(scope));
        return {
            device_id: device.device_id,
            epoch: device.epoch,
            scopes,
            jti: parsed.jti,
            expires_at: exp,
        };
    }

    /**
     * @param {string} deviceId
     */
    function revokeDevice(deviceId) {
        ensureIdentity();
        const current = /** @type {Record<string, any>} */ (state);
        const device = current.devices[deviceId];
        if (!device) throw authError('AUTH_INVALID');
        if (device.revoked) return { device_id: deviceId, epoch: device.epoch, revoked: true };
        const at = seconds();
        const next = structuredClone(current);
        next.devices[deviceId].revoked = true;
        next.devices[deviceId].epoch += 1;
        next.revocations.push({
            device_id: deviceId,
            epoch: next.devices[deviceId].epoch,
            revoked_at: at,
        });
        options.stateStore.save(next);
        state = next;
        for (const [id, challenge] of challenges) {
            if (challenge.device_id === deviceId) challenges.delete(id);
        }
        return { device_id: deviceId, epoch: next.devices[deviceId].epoch, revoked: true };
    }

    function close() {
        if (closed) return;
        closed = true;
        windows.clear();
        pendings.clear();
        challenges.clear();
        try { options.stateStore.close?.(); } finally { options.keyStore.close?.(); }
    }

    return {
        openPairingWindow: () => enqueue(openPairingWindow),
        closePairingWindow: (/** @type {string} */ windowId) => enqueue(() => closePairingWindow(windowId)),
        submitPairing: (/** @type {any} */ input) => enqueue(() => submitPairing(input)),
        inspectPairing: (/** @type {string} */ pendingId) => enqueue(() => inspectPairing(pendingId)),
        confirmPairing: (/** @type {any} */ input) => enqueue(() => confirmPairing(input)),
        issueChallenge: (/** @type {any} */ input) => enqueue(() => issueChallenge(input)),
        exchangeProof: (/** @type {any} */ input) => enqueue(() => exchangeProof(input)),
        authenticate: (/** @type {string} */ token) => enqueue(() => authenticate(token)),
        revokeDevice: (/** @type {string} */ deviceId) => enqueue(() => revokeDevice(deviceId)),
        close,
    };
}

/**
 * @param {typeof http | typeof https} transportModule
 * @param {URL} base
 * @param {string} pathname
 * @param {unknown} body
 * @returns {Promise<any>}
 */
function requestJson(transportModule, base, pathname, body) {
    if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.includes('?')) {
        return Promise.reject(authError('AUTH_INVALID'));
    }
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    if (payload.length > AUTH_LIMITS.bodyBytes) return Promise.reject(authError('AUTH_INVALID'));
    const target = new URL(pathname, base);
    return new Promise((resolve, reject) => {
        const req = transportModule.request({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port,
            path: target.pathname,
            method: 'POST',
            rejectUnauthorized: true,
            headers: {
                'content-type': 'application/json',
                'content-length': String(payload.length),
                host: target.host,
            },
        }, (res) => {
            /** @type {Buffer[]} */
            const chunks = [];
            let total = 0;
            res.on('data', (chunk) => {
                total += chunk.length;
                if (total > AUTH_LIMITS.bodyBytes) {
                    req.destroy();
                    reject(authError('AUTH_INVALID'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                /** @type {any} */
                let parsed;
                try {
                    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                } catch {
                    reject(authError('AUTH_INVALID'));
                    return;
                }
                if ((res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300) {
                    resolve(parsed);
                    return;
                }
                const code = parsed?.error?.code;
                if (typeof code === 'string' && Object.hasOwn(AUTH_ERROR_MESSAGES, code)) {
                    reject(authError(/** @type {keyof typeof AUTH_ERROR_MESSAGES} */ (code)));
                    return;
                }
                reject(authError('AUTH_INVALID'));
            });
        });
        req.setTimeout(5000, () => {
            req.destroy();
            reject(authError('AUTH_INVALID'));
        });
        req.on('error', () => reject(authError('AUTH_INVALID')));
        req.end(payload);
    });
}

/**
 * Test-only loopback HTTP. Production callers use createHttpsTransport.
 * @param {{ baseUrl: string }} options
 */
export function createLoopbackHttpTransport(options) {
    const base = new URL(options.baseUrl);
    if (base.protocol !== 'http:' || (base.hostname !== '127.0.0.1' && base.hostname !== 'localhost')) {
        throw authError('AUTH_INVALID');
    }
    return {
        mode: 'loopback-http',
        loopback: true,
        /**
         * @param {string} pathname
         * @param {unknown} body
         */
        post(pathname, body) {
            return requestJson(http, base, pathname, body);
        },
    };
}

/**
 * HTTPS transport with normal certificate verification.
 * @param {{ origin: string }} options
 */
export function createHttpsTransport(options) {
    const base = new URL(options.origin);
    if (base.protocol !== 'https:' || base.username || base.password) throw authError('AUTH_INVALID');
    return {
        mode: 'https',
        /**
         * @param {string} pathname
         * @param {unknown} body
         */
        post(pathname, body) {
            return requestJson(https, base, pathname, body);
        },
    };
}

/**
 * @param {{
 *   transport: { mode?: string, loopback?: boolean, post: (pathname: string, body: unknown) => Promise<any> },
 *   keyStore: { sign: (keyId: string, bytes: Buffer) => Buffer },
 *   deviceId: string,
 *   keyId?: string,
 *   pinnedServer: { gateway_id: string, audience: string, public_key: unknown, resource?: string },
 *   scopes: unknown,
 *   now?: () => number,
 * }} options
 */
export function createTokenClient(options) {
    const transport = options?.transport;
    if (!transport || (transport.mode !== 'https' && transport.mode !== 'loopback-http')) throw authError('AUTH_INVALID');
    if (transport.mode === 'loopback-http' && transport.loopback !== true) throw authError('AUTH_INVALID');
    if (typeof options.deviceId !== 'string' || !GATEWAY_ID_RE.test(options.deviceId)) throw authError('AUTH_INVALID');
    const keyId = options.keyId ?? options.deviceId;
    if (typeof keyId !== 'string' || keyId.length === 0) throw authError('KEY_UNAVAILABLE');
    const pinnedKey = parsePublicJwk(options.pinnedServer?.public_key, 'KEY_UNAVAILABLE');
    const gateway = parseText(options.pinnedServer?.gateway_id);
    if (!GATEWAY_ID_RE.test(gateway)) throw authError('AUTH_INVALID');
    const audience = parseText(options.pinnedServer?.audience);
    const resource = options.pinnedServer?.resource === undefined ? audience : parseText(options.pinnedServer.resource);
    const scopes = normalizeScopes(options.scopes, false);
    const now = options.now ?? Date.now;
    /** @type {{ raw: string, iat: number, exp: number } | null} */
    let cache = null;
    /** @type {Promise<string> | null} */
    let inflight = null;
    let closed = false;

    /**
     * @param {string} token
     * @param {number} at
     */
    function acceptToken(token, at) {
        const payload = verifiedPayload(token, ACCESS_HEADER_JSON, pinnedKey);
        const parsed = parseExactJson(payload);
        const canonical = encodeAccessClaims(parsed);
        if (!canonical.equals(payload)) throw authError('AUTH_INVALID');
        if (parsed.iss !== gateway || parsed.aud !== audience || parsed.device_id !== options.deviceId || parsed.sub !== options.deviceId) {
            throw authError('AUTH_INVALID');
        }
        const tokenScopes = /** @type {string[]} */ (parsed.scope);
        if (tokenScopes.length !== scopes.length || tokenScopes.some((scope, index) => scope !== scopes[index])) {
            throw authError('SCOPE_DENIED');
        }
        const iat = /** @type {number} */ (parsed.iat);
        const exp = /** @type {number} */ (parsed.exp);
        if (iat > at + AUTH_LIMITS.maxIatSkewSeconds) throw authError('AUTH_INVALID');
        if (at >= exp) throw authError('AUTH_EXPIRED');
        return { raw: token, iat, exp };
    }

    async function renew() {
        const at = epochSeconds(now);
        const challenge = await transport.post('/auth/challenge', {
            protocol_version: AUTH_LIMITS.protocolVersion,
            device_id: options.deviceId,
            resource,
            requested_scopes: scopes,
        });
        const payload = decodeB64Url(challenge?.payload, 8192);
        if (!payload || challenge?.protocol_version !== AUTH_LIMITS.protocolVersion) throw authError('AUTH_INVALID');
        const parsed = parseExactJson(payload);
        const canonical = encodeChallengePayload(parsed);
        if (!canonical.equals(payload)) throw authError('AUTH_INVALID');
        if (
            parsed.gateway_id !== gateway
            || parsed.aud !== audience
            || parsed.device_id !== options.deviceId
            || parsed.resource !== resource
            || parsed.challenge_id !== challenge.challenge_id
        ) {
            throw authError('AUTH_INVALID');
        }
        const proof = signCompactJws(options.keyStore, keyId, CHALLENGE_HEADER_JSON, payload);
        const issued = await transport.post('/auth/token', {
            protocol_version: AUTH_LIMITS.protocolVersion,
            challenge_id: challenge.challenge_id,
            device_id: options.deviceId,
            proof,
        });
        if (typeof issued?.token !== 'string') throw authError('AUTH_INVALID');
        const accepted = acceptToken(issued.token, epochSeconds(now));
        cache = accepted;
        return accepted.raw;
    }

    return {
        async getAccessToken() {
            if (closed) throw authError('AUTH_INVALID');
            const at = epochSeconds(now);
            if (cache && at < cache.exp && at < cache.iat + AUTH_LIMITS.renewAfterSeconds) return cache.raw;
            if (!inflight) {
                inflight = renew().finally(() => {
                    inflight = null;
                });
            }
            try {
                return await inflight;
            } catch (error) {
                const code = error instanceof AgentAuthError ? error.code : '';
                if (code === 'DEVICE_REVOKED') cache = null;
                const nowSeconds = epochSeconds(now);
                if (cache && nowSeconds >= cache.exp) cache = null;
                if (cache && nowSeconds < cache.exp && !FATAL_RENEWAL.has(code)) return cache.raw;
                if (error instanceof AgentAuthError) throw error;
                throw authError('AUTH_INVALID');
            }
        },
        close() {
            closed = true;
            cache = null;
            inflight = null;
        },
    };
}
