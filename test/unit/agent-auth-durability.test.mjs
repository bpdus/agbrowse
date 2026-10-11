import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthService, signCompactJws } from '../../skills/browser/agent-auth.mjs';
import { createDevFileKeyStore, createJsonStateStore } from '../../skills/browser/agent-auth-store.mjs';

const CHALLENGE_HEADER = '{"alg":"ES256","typ":"paired-device-v1+challenge"}';
const AUDIENCE = 'https://gw.example/mcp';
const cleanups = [];

afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()();
});

/**
 * @param {Record<string, unknown>} overrides
 */
function wrapFs(overrides) {
    return new Proxy(fs, {
        get(target, prop, receiver) {
            if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}

/**
 * @param {typeof fs} [stateFs]
 */
function harness(stateFs = fs) {
    const root = mkdtempSync(join(tmpdir(), 'agent-auth-durability-'));
    const dirs = {
        state: join(root, 'state'),
        server: join(root, 'server-keys'),
        device: join(root, 'device-keys'),
    };
    let ms = 1_700_000_000_000;
    const stateStore = createJsonStateStore({ directory: dirs.state, fs: stateFs });
    const keyStore = createDevFileKeyStore({ directory: dirs.server });
    const deviceKeys = createDevFileKeyStore({ directory: dirs.device });
    const auth = createAuthService({
        stateStore,
        keyStore,
        gatewayId: 'gw_test',
        audience: AUDIENCE,
        now: () => ms,
    });
    const localId = 'device-local';
    const publicKey = deviceKeys.ensureKey(localId);
    cleanups.push(() => {
        for (const resource of [auth, stateStore, keyStore, deviceKeys]) {
            try { resource.close(); } catch { /* already closed */ }
        }
        try { chmodSync(dirs.state, 0o700); } catch { /* missing */ }
        rmSync(root, { recursive: true, force: true });
    });
    return {
        root,
        dirs,
        auth,
        deviceKeys,
        publicKey,
        localId,
        advance(seconds) { ms += seconds * 1000; },
    };
}

/**
 * @param {ReturnType<typeof harness>} box
 * @param {string} [name]
 */
async function pair(box, name = 'phone') {
    await box.auth.openPairingWindow();
    const pending = await box.auth.submitPairing({
        publicKey: box.publicKey,
        name,
        requestedScopes: ['browser:read'],
    });
    const confirmed = await box.auth.confirmPairing({
        pendingId: pending.pending_id,
        code: pending.confirmation_code,
        fingerprint: pending.fingerprint,
        grantedScopes: ['browser:read'],
    });
    return { pending, confirmed };
}

/**
 * @param {ReturnType<typeof harness>} box
 * @param {string} deviceId
 */
async function issueToken(box, deviceId) {
    const challenge = await box.auth.issueChallenge({
        deviceId,
        requestedScopes: ['browser:read'],
    });
    const proof = signCompactJws(
        box.deviceKeys,
        box.localId,
        CHALLENGE_HEADER,
        Buffer.from(challenge.payload, 'base64url'),
    );
    const issued = await box.auth.exchangeProof({
        challengeId: challenge.challenge_id,
        deviceId,
        proof,
    });
    return issued.token;
}

describe('paired-device durability', () => {
    it('propagates a directory fsync failure after key rename', () => {
        const root = mkdtempSync(join(tmpdir(), 'agent-auth-key-'));
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        const directory = join(root, 'keys');
        let directorySyncs = 0;
        const io = wrapFs({
            fsyncSync(fd) {
                const stat = fs.fstatSync(fd);
                if (stat.isDirectory()) {
                    directorySyncs += 1;
                    const error = new Error('injected directory fsync failure');
                    error.code = 'EIO';
                    throw error;
                }
                return fs.fsyncSync(fd);
            },
        });
        const store = createDevFileKeyStore({ directory, fs: io });
        cleanups.push(() => store.close());
        expect(() => store.ensureKey('gateway-signing')).toThrow(expect.objectContaining({ code: 'STATE_UNSAFE' }));
        expect(directorySyncs).toBe(1);
        expect(existsSync(join(directory, 'gateway-signing.pem'))).toBe(true);
    });

    it('rejects tokens when revocation cannot be synced, and a later save keeps the disk revocation', async () => {
        const fault = { directory: false, file: false };
        const io = wrapFs({
            fsyncSync(fd) {
                const stat = fs.fstatSync(fd);
                if (fault.directory && stat.isDirectory()) {
                    const error = new Error('injected directory fsync failure');
                    error.code = 'EIO';
                    throw error;
                }
                if (fault.file && stat.isFile()) {
                    const error = new Error('injected file fsync failure');
                    error.code = 'EIO';
                    throw error;
                }
                return fs.fsyncSync(fd);
            },
        });
        const durable = harness(io);
        const paired = await pair(durable);
        const token = await issueToken(durable, paired.confirmed.device_id);
        const statePath = join(durable.dirs.state, 'state.json');
        const before = readFileSync(statePath);

        fault.directory = true;
        await expect(durable.auth.revokeDevice(paired.confirmed.device_id)).rejects.toMatchObject({ code: 'STATE_UNSAFE' });
        fault.directory = false;
        expect(readFileSync(statePath).equals(before)).toBe(false);
        expect(JSON.parse(readFileSync(statePath, 'utf8')).devices[paired.confirmed.device_id].revoked).toBe(true);
        await expect(durable.auth.authenticate(token)).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
        await expect(durable.auth.issueChallenge({
            deviceId: paired.confirmed.device_id,
            requestedScopes: ['browser:read'],
        })).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });

        const second = await pair(durable, 'phone-2');
        const saved = JSON.parse(readFileSync(statePath, 'utf8'));
        expect(saved.devices[paired.confirmed.device_id].revoked).toBe(true);
        expect(saved.devices[second.confirmed.device_id].revoked).toBe(false);
        await expect(durable.auth.authenticate(token)).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
    });

    it('rejects tokens when revocation fails before rename, then persists that revocation', async () => {
        const fault = { file: false };
        const io = wrapFs({
            fsyncSync(fd) {
                if (fault.file && fs.fstatSync(fd).isFile()) {
                    const error = new Error('injected file fsync failure');
                    error.code = 'EIO';
                    throw error;
                }
                return fs.fsyncSync(fd);
            },
        });
        const box = harness(io);
        const paired = await pair(box);
        const token = await issueToken(box, paired.confirmed.device_id);
        const statePath = join(box.dirs.state, 'state.json');
        const before = readFileSync(statePath);

        fault.file = true;
        await expect(box.auth.revokeDevice(paired.confirmed.device_id)).rejects.toMatchObject({ code: 'STATE_UNSAFE' });
        fault.file = false;
        expect(readFileSync(statePath).equals(before)).toBe(true);
        await expect(box.auth.authenticate(token)).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });

        await pair(box, 'phone-2');
        const saved = JSON.parse(readFileSync(statePath, 'utf8'));
        expect(saved.devices[paired.confirmed.device_id].revoked).toBe(true);
    });

    it('retries a pending revocation until it is saved, then keeps it across restart', async () => {
        let failSave = false;
        let stateSaves = 0;
        const io = wrapFs({
            renameSync(from, to) {
                if (String(to).endsWith('/state.json')) {
                    stateSaves += 1;
                    if (failSave) {
                        const error = new Error('injected pre-rename failure');
                        error.code = 'EIO';
                        throw error;
                    }
                }
                return fs.renameSync(from, to);
            },
        });
        const box = harness(io);
        const paired = await pair(box);
        const token = await issueToken(box, paired.confirmed.device_id);
        const statePath = join(box.dirs.state, 'state.json');
        const deviceId = paired.confirmed.device_id;

        const savesBefore = stateSaves;
        failSave = true;
        await expect(box.auth.revokeDevice(deviceId)).rejects.toMatchObject({ code: 'STATE_UNSAFE' });
        expect(stateSaves).toBe(savesBefore + 1);
        failSave = false;
        expect(JSON.parse(readFileSync(statePath, 'utf8')).devices[deviceId].revoked).toBe(false);
        await expect(box.auth.authenticate(token)).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });

        const savesAfterFailure = stateSaves;
        const revoked = await box.auth.revokeDevice(deviceId);
        expect(stateSaves).toBe(savesAfterFailure + 1);
        expect(revoked).toEqual({ device_id: deviceId, epoch: 2, revoked: true });
        expect(JSON.parse(readFileSync(statePath, 'utf8')).devices[deviceId].revoked).toBe(true);

        box.auth.close();
        const stateStore = createJsonStateStore({ directory: box.dirs.state, fs: io });
        const keyStore = createDevFileKeyStore({ directory: box.dirs.server });
        const restarted = createAuthService({
            stateStore,
            keyStore,
            gatewayId: 'gw_test',
            audience: AUDIENCE,
            now: () => 1_700_000_000_000,
        });
        cleanups.push(() => {
            try { restarted.close(); } catch { /* already closed */ }
            try { stateStore.close(); } catch { /* already closed */ }
            try { keyStore.close(); } catch { /* already closed */ }
        });
        const saved = JSON.parse(readFileSync(statePath, 'utf8'));
        expect(saved.devices[deviceId].revoked).toBe(true);
        await expect(restarted.authenticate(token)).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
    });

    it('reloads a disk revocation before a later save so stale memory cannot erase it', async () => {
        const box = harness();
        const paired = await pair(box);
        const token = await issueToken(box, paired.confirmed.device_id);
        const statePath = join(box.dirs.state, 'state.json');
        const saved = JSON.parse(readFileSync(statePath, 'utf8'));
        saved.devices[paired.confirmed.device_id].revoked = true;
        saved.devices[paired.confirmed.device_id].epoch = 2;
        saved.revocations.push({
            device_id: paired.confirmed.device_id,
            epoch: 2,
            revoked_at: 1_700_000_000,
        });
        writeFileSync(statePath, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
        chmodSync(statePath, 0o600);

        const second = await pair(box, 'phone-2');
        const after = JSON.parse(readFileSync(statePath, 'utf8'));
        expect(after.devices[paired.confirmed.device_id].revoked).toBe(true);
        expect(after.devices[paired.confirmed.device_id].epoch).toBe(2);
        expect(after.devices[second.confirmed.device_id].revoked).toBe(false);
        await expect(box.auth.authenticate(token)).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
    });

    it('rejects a symlinked ancestor and an unsafe directory before writing', async () => {
        const root = mkdtempSync(join(tmpdir(), 'agent-auth-ancestor-'));
        cleanups.push(() => rmSync(root, { recursive: true, force: true }));
        const realParent = join(root, 'real');
        const linkedParent = join(root, 'linked');
        mkdirSync(realParent, { mode: 0o755 });
        symlinkSync(realParent, linkedParent);
        const linkedStore = join(linkedParent, 'state');
        mkdirSync(linkedStore, { mode: 0o700 });
        chmodSync(linkedStore, 0o700);
        expect(() => createJsonStateStore({ directory: linkedStore })).toThrow(expect.objectContaining({ code: 'STATE_UNSAFE' }));

        const parent = join(root, 'plain');
        const directory = join(parent, 'state');
        mkdirSync(parent, { mode: 0o755 });
        mkdirSync(directory, { mode: 0o700 });
        chmodSync(directory, 0o700);
        const io = wrapFs({
            lstatSync(target, options) {
                const stat = fs.lstatSync(target, options);
                if (target === parent) {
                    return new Proxy(stat, {
                        get(inner, prop, receiver) {
                            if (prop === 'isSymbolicLink') return () => true;
                            if (prop === 'isDirectory') return () => false;
                            if (prop === 'isFile') return () => false;
                            const value = Reflect.get(inner, prop, receiver);
                            return typeof value === 'function' ? value.bind(inner) : value;
                        },
                    });
                }
                return stat;
            },
        });
        expect(() => createJsonStateStore({ directory, fs: io })).toThrow(expect.objectContaining({ code: 'STATE_UNSAFE' }));

        let spoof = '';
        let watched = '';
        const writing = wrapFs({
            lstatSync(target, options) {
                const stat = fs.lstatSync(target, options);
                if (spoof !== '' && target === watched) {
                    return new Proxy(stat, {
                        get(inner, prop, receiver) {
                            if (prop === 'mode' && spoof === 'mode') return (inner.mode & ~0o777) | 0o770;
                            if (prop === 'uid' && spoof === 'uid') return inner.uid + 1;
                            const value = Reflect.get(inner, prop, receiver);
                            return typeof value === 'function' ? value.bind(inner) : value;
                        },
                    });
                }
                return stat;
            },
        });
        const box = harness(writing);
        watched = box.dirs.state;
        const opened = await box.auth.openPairingWindow();
        const pending = await box.auth.submitPairing({
            publicKey: box.publicKey,
            name: 'phone',
            requestedScopes: ['browser:read'],
        });
        const statePath = join(box.dirs.state, 'state.json');
        const before = readFileSync(statePath);
        spoof = 'mode';
        await expect(box.auth.confirmPairing({
            pendingId: pending.pending_id,
            code: pending.confirmation_code,
            fingerprint: pending.fingerprint,
            grantedScopes: ['browser:read'],
        })).rejects.toMatchObject({ code: 'STATE_UNSAFE' });
        expect(readFileSync(statePath).equals(before)).toBe(true);
        spoof = 'uid';
        await expect(box.auth.confirmPairing({
            pendingId: pending.pending_id,
            code: pending.confirmation_code,
            fingerprint: pending.fingerprint,
            grantedScopes: ['browser:read'],
        })).rejects.toMatchObject({ code: 'STATE_UNSAFE' });
        expect(readFileSync(statePath).equals(before)).toBe(true);
        expect(opened.window_id).toMatch(/^win_/);

        spoof = '';
        const live = harness();
        await live.auth.openPairingWindow();
        const livePending = await live.auth.submitPairing({
            publicKey: live.publicKey,
            name: 'phone',
            requestedScopes: ['browser:read'],
        });
        const livePath = join(live.dirs.state, 'state.json');
        const liveBefore = readFileSync(livePath);
        chmodSync(live.dirs.state, 0o770);
        await expect(live.auth.confirmPairing({
            pendingId: livePending.pending_id,
            code: livePending.confirmation_code,
            fingerprint: livePending.fingerprint,
            grantedScopes: ['browser:read'],
        })).rejects.toMatchObject({ code: 'STATE_UNSAFE' });
        chmodSync(live.dirs.state, 0o700);
        expect(readFileSync(livePath).equals(liveBefore)).toBe(true);
    });

    it('forgets expired challenge ids beyond the memory bound', async () => {
        const box = harness();
        const paired = await pair(box);
        /** @type {string[]} */
        const ids = [];
        for (let index = 0; index < 1025; index += 1) {
            const challenge = await box.auth.issueChallenge({
                deviceId: paired.confirmed.device_id,
                requestedScopes: ['browser:read'],
            });
            ids.push(challenge.challenge_id);
            box.advance(60);
        }
        await box.auth.issueChallenge({
            deviceId: paired.confirmed.device_id,
            requestedScopes: ['browser:read'],
        });
        await expect(box.auth.exchangeProof({
            challengeId: ids[0],
            deviceId: paired.confirmed.device_id,
            proof: 'not-a-proof',
        })).rejects.toMatchObject({ code: 'AUTH_INVALID' });
        await expect(box.auth.exchangeProof({
            challengeId: ids[1],
            deviceId: paired.confirmed.device_id,
            proof: 'not-a-proof',
        })).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    });
});
