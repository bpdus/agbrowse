import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthService, createHttpsTransport, createLoopbackHttpTransport, createTokenClient, encodeAccessClaims, signCompactJws } from '../../skills/browser/agent-auth.mjs';
import { createDevFileKeyStore, createJsonStateStore } from '../../skills/browser/agent-auth-store.mjs';

const ACCESS_HEADER = '{"alg":"ES256","typ":"paired-device-v1+access"}';
const CHALLENGE_HEADER = '{"alg":"ES256","typ":"paired-device-v1+challenge"}';
const AUDIENCE = 'https://gw.example/mcp';
const cleanups = [];

afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()();
});

function removeTree(root) {
    chmodSync(root, 0o700);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const target = join(root, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
            chmodSync(target, 0o700);
            for (const name of readdirSync(target)) {
                try { chmodSync(join(target, name), 0o600); } catch { /* already removed */ }
            }
        }
    }
    rmSync(root, { recursive: true, force: true });
}

function harness(audience = AUDIENCE, gatewayId = 'gw_test') {
    const root = mkdtempSync(join(tmpdir(), 'agent-auth-'));
    const dirs = {
        state: join(root, 'state'),
        server: join(root, 'server-keys'),
        device: join(root, 'device-keys'),
    };
    let ms = 1_700_000_000_000;
    const stateStore = createJsonStateStore({ directory: dirs.state });
    const keyStore = createDevFileKeyStore({ directory: dirs.server });
    const deviceKeys = createDevFileKeyStore({ directory: dirs.device });
    const auth = createAuthService({
        stateStore,
        keyStore,
        gatewayId,
        audience,
        now: () => ms,
    });
    const localId = 'device-local';
    const publicKey = deviceKeys.ensureKey(localId);
    const resources = { auth, stateStore, keyStore, deviceKeys };
    cleanups.push(() => {
        for (const resource of Object.values(resources)) {
            try { resource.close(); } catch { /* closed already */ }
        }
        removeTree(root);
    });
    return {
        root,
        dirs,
        auth,
        keyStore,
        deviceKeys,
        publicKey,
        localId,
        now: () => ms,
        setNow(value) { ms = value; },
        advance(seconds) { ms += seconds * 1000; },
        seconds() { return Math.floor(ms / 1000); },
    };
}

async function pair(box, scopes = ['browser:read'], granted = scopes) {
    const opened = await box.auth.openPairingWindow();
    const pending = await box.auth.submitPairing({
        publicKey: box.publicKey,
        name: 'phone',
        requestedScopes: scopes,
    });
    const confirmed = await box.auth.confirmPairing({
        pendingId: pending.pending_id,
        code: pending.confirmation_code,
        fingerprint: pending.fingerprint,
        grantedScopes: granted,
    });
    return { opened, pending, confirmed };
}

function proofFor(box, payload) {
    return signCompactJws(box.deviceKeys, box.localId, CHALLENGE_HEADER, Buffer.from(payload, 'base64url'));
}

function directTransport(auth) {
    return {
        mode: 'loopback-http',
        loopback: true,
        async post(pathname, body) {
            if (pathname === '/auth/challenge') {
                return auth.issueChallenge({
                    deviceId: body.device_id,
                    resource: body.resource,
                    requestedScopes: body.requested_scopes,
                });
            }
            if (pathname === '/auth/token') {
                return auth.exchangeProof({
                    challengeId: body.challenge_id,
                    deviceId: body.device_id,
                    proof: body.proof,
                });
            }
            throw new Error('unexpected path');
        },
    };
}

describe('paired-device auth', () => {
    it('pairs a device when the code and fingerprint match', async () => {
        const box = harness();
        const { pending, confirmed } = await pair(box);
        expect(confirmed.epoch).toBe(1);
        expect(confirmed.device_id).toMatch(/^dev_/);
        expect(confirmed.server).toMatchObject({
            gateway_id: 'gw_test',
            audience: AUDIENCE,
            public_key: box.keyStore.getPublicKey('gateway-signing'),
        });
        const inspected = await box.auth.inspectPairing(pending.pending_id).catch((error) => error);
        expect(inspected.code).toBe('AUTH_INVALID');
        const challenge = await box.auth.issueChallenge({
            deviceId: confirmed.device_id,
            requestedScopes: ['browser:read'],
        });
        const issued = await box.auth.exchangeProof({
            challengeId: challenge.challenge_id,
            deviceId: confirmed.device_id,
            proof: proofFor(box, challenge.payload),
        });
        const authed = await box.auth.authenticate(issued.token);
        expect(authed.device_id).toBe(confirmed.device_id);
        expect(authed.scopes).toEqual(['browser:read']);
        expect(authed.expires_at - box.seconds()).toBe(300);
    });

    it('rejects a wrong code, wrong fingerprint, expiry, attempt cap, and a closed window', async () => {
        const closed = harness();
        const opened = await closed.auth.openPairingWindow();
        await closed.auth.closePairingWindow(opened.window_id);
        await expect(closed.auth.submitPairing({
            publicKey: closed.publicKey,
            name: 'phone',
            requestedScopes: ['browser:read'],
        })).rejects.toMatchObject({ code: 'PAIRING_CLOSED' });

        const expired = harness();
        await expired.auth.openPairingWindow();
        expired.advance(120);
        await expect(expired.auth.submitPairing({
            publicKey: expired.publicKey,
            name: 'phone',
            requestedScopes: ['browser:read'],
        })).rejects.toMatchObject({ code: 'PAIRING_EXPIRED' });

        const box = harness();
        await box.auth.openPairingWindow();
        const pending = await box.auth.submitPairing({
            publicKey: box.publicKey,
            name: 'phone',
            requestedScopes: ['browser:read', 'cart:write'],
        });
        await expect(box.auth.confirmPairing({
            pendingId: pending.pending_id,
            code: 'WRONGCODE',
            fingerprint: pending.fingerprint,
            grantedScopes: ['browser:read'],
        })).rejects.toMatchObject({ code: 'AUTH_INVALID', message: 'Authentication was rejected.' });
        await expect(box.auth.confirmPairing({
            pendingId: pending.pending_id,
            code: pending.confirmation_code,
            fingerprint: 'not-the-fingerprint',
            grantedScopes: ['browser:read'],
        })).rejects.toMatchObject({ code: 'AUTH_INVALID' });
        for (let attempt = 0; attempt < 3; attempt += 1) {
            await box.auth.confirmPairing({
                pendingId: pending.pending_id,
                code: 'WRONGCODE',
                fingerprint: pending.fingerprint,
                grantedScopes: ['browser:read'],
            }).catch(() => {});
        }
        await expect(box.auth.confirmPairing({
            pendingId: pending.pending_id,
            code: pending.confirmation_code,
            fingerprint: pending.fingerprint,
            grantedScopes: ['browser:read'],
        })).rejects.toMatchObject({ code: 'AUTH_INVALID' });

        const late = harness();
        await late.auth.openPairingWindow();
        const latePending = await late.auth.submitPairing({
            publicKey: late.publicKey,
            name: 'phone',
            requestedScopes: ['browser:read'],
        });
        late.advance(120);
        await expect(late.auth.confirmPairing({
            pendingId: latePending.pending_id,
            code: latePending.confirmation_code,
            fingerprint: latePending.fingerprint,
            grantedScopes: ['browser:read'],
        })).rejects.toMatchObject({ code: 'PAIRING_EXPIRED' });

        const denied = harness();
        await denied.auth.openPairingWindow();
        const deniedPending = await denied.auth.submitPairing({
            publicKey: denied.publicKey,
            name: 'phone',
            requestedScopes: ['browser:read'],
        });
        await expect(denied.auth.confirmPairing({
            pendingId: deniedPending.pending_id,
            code: deniedPending.confirmation_code,
            fingerprint: deniedPending.fingerprint,
            grantedScopes: ['cart:write'],
        })).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
    });

    it('rejects a bad proof, altered payload, wrong key, and another server binding', async () => {
        const box = harness();
        const { confirmed } = await pair(box);
        const challenge = await box.auth.issueChallenge({
            deviceId: confirmed.device_id,
            requestedScopes: ['browser:read'],
        });
        const valid = proofFor(box, challenge.payload);
        const [header, payload, signature] = valid.split('.');
        await expect(box.auth.exchangeProof({
            challengeId: challenge.challenge_id,
            deviceId: confirmed.device_id,
            proof: `${header}.${payload}.${signature.slice(0, -1)}${signature.endsWith('a') ? 'b' : 'a'}`,
        })).rejects.toMatchObject({ code: 'AUTH_INVALID' });

        const parsed = JSON.parse(Buffer.from(challenge.payload, 'base64url').toString('utf8'));
        parsed.aud = 'https://other.example/mcp';
        const altered = Buffer.from(JSON.stringify(parsed)).toString('base64url');
        await expect(box.auth.exchangeProof({
            challengeId: challenge.challenge_id,
            deviceId: confirmed.device_id,
            proof: proofFor(box, altered),
        })).rejects.toMatchObject({ code: 'AUTH_INVALID' });

        const other = createDevFileKeyStore({ directory: join(box.root, 'other-keys') });
        cleanups.push(() => other.close());
        other.ensureKey('other-device');
        await expect(box.auth.exchangeProof({
            challengeId: challenge.challenge_id,
            deviceId: confirmed.device_id,
            proof: signCompactJws(other, 'other-device', CHALLENGE_HEADER, Buffer.from(challenge.payload, 'base64url')),
        })).rejects.toMatchObject({ code: 'AUTH_INVALID' });

        const issued = await box.auth.exchangeProof({
            challengeId: challenge.challenge_id,
            deviceId: confirmed.device_id,
            proof: valid,
        });
        const otherServer = harness('https://other.example/mcp', 'gw_other');
        const foreign = await pair(otherServer);
        const foreignChallenge = await otherServer.auth.issueChallenge({
            deviceId: foreign.confirmed.device_id,
            requestedScopes: ['browser:read'],
        });
        const foreignIssued = await otherServer.auth.exchangeProof({
            challengeId: foreignChallenge.challenge_id,
            deviceId: foreign.confirmed.device_id,
            proof: proofFor(otherServer, foreignChallenge.payload),
        });
        await expect(box.auth.authenticate(foreignIssued.token)).rejects.toMatchObject({ code: 'AUTH_INVALID' });
        const rebound = signCompactJws(box.keyStore, 'gateway-signing', ACCESS_HEADER, encodeAccessClaims({
            iss: 'gw_test',
            aud: 'https://other.example/mcp',
            sub: confirmed.device_id,
            device_id: confirmed.device_id,
            scope: ['browser:read'],
            iat: box.seconds(),
            exp: box.seconds() + 300,
            jti: 'jti_other_audience',
            device_epoch: 1,
        }));
        await expect(box.auth.authenticate(rebound)).rejects.toMatchObject({ code: 'AUTH_INVALID' });
        expect((await box.auth.authenticate(issued.token)).device_id).toBe(confirmed.device_id);
    });

    it('rejects challenge reuse and expiry at the boundary', async () => {
        const box = harness();
        const { confirmed } = await pair(box);
        const challenge = await box.auth.issueChallenge({
            deviceId: confirmed.device_id,
            requestedScopes: ['browser:read'],
        });
        const proof = proofFor(box, challenge.payload);
        const input = { challengeId: challenge.challenge_id, deviceId: confirmed.device_id, proof };
        const [first, second] = await Promise.allSettled([
            box.auth.exchangeProof(input),
            box.auth.exchangeProof(input),
        ]);
        const ok = [first, second].filter((item) => item.status === 'fulfilled');
        const rejected = [first, second].filter((item) => item.status === 'rejected');
        expect(ok).toHaveLength(1);
        expect(rejected[0].reason.code).toBe('CHALLENGE_USED');
        await expect(box.auth.exchangeProof(input)).rejects.toMatchObject({ code: 'CHALLENGE_USED' });

        const boundary = await box.auth.issueChallenge({
            deviceId: confirmed.device_id,
            requestedScopes: ['browser:read'],
        });
        const exp = box.seconds() + 30;
        box.setNow((exp - 1) * 1000);
        const fresh = await box.auth.exchangeProof({
            challengeId: boundary.challenge_id,
            deviceId: confirmed.device_id,
            proof: proofFor(box, boundary.payload),
        });
        expect(fresh.expires_in).toBe(300);
        const expired = await box.auth.issueChallenge({
            deviceId: confirmed.device_id,
            requestedScopes: ['browser:read'],
        });
        box.setNow(box.seconds() * 1000 + 30_000);
        await expect(box.auth.exchangeProof({
            challengeId: expired.challenge_id,
            deviceId: confirmed.device_id,
            proof: proofFor(box, expired.payload),
        })).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    });

    it('rejects tampered, mistargeted, expired, unknown, revoked, and stale tokens', async () => {
        const box = harness();
        const { confirmed } = await pair(box, ['browser:read', 'cart:write']);
        const challenge = await box.auth.issueChallenge({
            deviceId: confirmed.device_id,
            requestedScopes: ['browser:read', 'cart:write'],
        });
        const issued = await box.auth.exchangeProof({
            challengeId: challenge.challenge_id,
            deviceId: confirmed.device_id,
            proof: proofFor(box, challenge.payload),
        });
        const token = issued.token;
        const flipped = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
        await expect(box.auth.authenticate(flipped)).rejects.toMatchObject({ code: 'AUTH_INVALID' });
        await expect(box.auth.authenticate('not-a-token')).rejects.toMatchObject({ code: 'AUTH_INVALID' });

        const at = box.seconds();
        const stale = signCompactJws(box.keyStore, 'gateway-signing', ACCESS_HEADER, encodeAccessClaims({
            iss: 'gw_test',
            aud: AUDIENCE,
            sub: confirmed.device_id,
            device_id: confirmed.device_id,
            scope: ['browser:read', 'approval:write'],
            iat: at,
            exp: at + 300,
            jti: 'jti_stale_epoch_1',
            device_epoch: 99,
        }));
        await expect(box.auth.authenticate(stale)).rejects.toMatchObject({ code: 'AUTH_INVALID' });
        const mixed = signCompactJws(box.keyStore, 'gateway-signing', ACCESS_HEADER, encodeAccessClaims({
            iss: 'gw_test',
            aud: AUDIENCE,
            sub: confirmed.device_id,
            device_id: confirmed.device_id,
            scope: ['approval:write', 'browser:read'],
            iat: at,
            exp: at + 300,
            jti: 'jti_mixed_scope_1',
            device_epoch: 1,
        }));
        expect((await box.auth.authenticate(mixed)).scopes).toEqual(['browser:read']);
        const early = signCompactJws(box.keyStore, 'gateway-signing', ACCESS_HEADER, encodeAccessClaims({
            iss: 'gw_test',
            aud: AUDIENCE,
            sub: confirmed.device_id,
            device_id: confirmed.device_id,
            scope: ['browser:read'],
            iat: at + 31,
            exp: at + 331,
            jti: 'jti_future_iat_31',
            device_epoch: 1,
        }));
        await expect(box.auth.authenticate(early)).rejects.toMatchObject({ code: 'AUTH_INVALID' });
        const skewed = signCompactJws(box.keyStore, 'gateway-signing', ACCESS_HEADER, encodeAccessClaims({
            iss: 'gw_test',
            aud: AUDIENCE,
            sub: confirmed.device_id,
            device_id: confirmed.device_id,
            scope: ['browser:read'],
            iat: at + 30,
            exp: at + 330,
            jti: 'jti_future_iat_30',
            device_epoch: 1,
        }));
        expect((await box.auth.authenticate(skewed)).expires_at).toBe(at + 330);

        box.setNow((at + 300) * 1000);
        await expect(box.auth.authenticate(token)).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
        box.setNow(at * 1000);
        await expect(box.auth.authenticate('header.payload.signature')).rejects.toMatchObject({ code: 'AUTH_INVALID' });
        await expect(box.auth.issueChallenge({
            deviceId: 'dev_missing',
            requestedScopes: ['browser:read'],
        })).rejects.toMatchObject({ code: 'AUTH_INVALID' });

        const revoked = await box.auth.revokeDevice(confirmed.device_id);
        expect(revoked.epoch).toBe(2);
        await expect(box.auth.authenticate(token)).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
        await expect(box.auth.issueChallenge({
            deviceId: confirmed.device_id,
            requestedScopes: ['browser:read'],
        })).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
        await expect(box.auth.exchangeProof({
            challengeId: challenge.challenge_id,
            deviceId: confirmed.device_id,
            proof: proofFor(box, challenge.payload),
        })).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
    });

    it('renews three times, shares one refresh, and stops after revocation or expiry', async () => {
        const box = harness();
        const { confirmed } = await pair(box);
        let calls = 0;
        let hold = null;
        const real = directTransport(box.auth);
        const transport = {
            mode: 'loopback-http',
            loopback: true,
            async post(pathname, body) {
                if (pathname === '/auth/challenge') {
                    calls += 1;
                    if (hold) await hold;
                }
                return real.post(pathname, body);
            },
        };
        const client = createTokenClient({
            transport,
            keyStore: box.deviceKeys,
            deviceId: confirmed.device_id,
            keyId: box.localId,
            pinnedServer: confirmed.server,
            scopes: ['browser:read'],
            now: box.now,
        });
        const tokens = [await client.getAccessToken()];
        box.advance(239);
        expect(await client.getAccessToken()).toBe(tokens[0]);
        for (let index = 0; index < 3; index += 1) {
            box.advance(index === 0 ? 1 : 240);
            tokens.push(await client.getAccessToken());
        }
        expect(new Set(tokens).size).toBe(4);
        expect(calls).toBe(4);

        let release;
        hold = new Promise((resolve) => { release = resolve; });
        const before = calls;
        box.advance(240);
        const pending = Promise.all([client.getAccessToken(), client.getAccessToken(), client.getAccessToken()]);
        await vi.waitFor(() => { expect(calls).toBe(before + 1); });
        release();
        const refreshed = await pending;
        expect(new Set(refreshed).size).toBe(1);
        expect(calls).toBe(before + 1);

        box.advance(300);
        hold = Promise.resolve();
        const realPost = transport.post.bind(transport);
        transport.post = async () => { throw new Error('renew failed'); };
        await expect(client.getAccessToken()).rejects.toThrow(/Authentication was rejected/);
        transport.post = realPost;
        hold = null;
        await box.auth.revokeDevice(confirmed.device_id);
        await expect(client.getAccessToken()).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
        client.close();
    });

    it('keeps identity, devices, and revocation across restart and drops old challenges', async () => {
        const box = harness();
        const { confirmed } = await pair(box);
        const challenge = await box.auth.issueChallenge({
            deviceId: confirmed.device_id,
            requestedScopes: ['browser:read'],
        });
        await box.auth.revokeDevice(confirmed.device_id);
        box.auth.close();
        const stateStore = createJsonStateStore({ directory: box.dirs.state });
        const keyStore = createDevFileKeyStore({ directory: box.dirs.server });
        cleanups.push(() => { stateStore.close(); keyStore.close(); });
        const restarted = createAuthService({
            stateStore,
            keyStore,
            gatewayId: 'gw_test',
            audience: AUDIENCE,
            now: box.now,
        });
        cleanups.push(() => restarted.close());
        await expect(restarted.exchangeProof({
            challengeId: challenge.challenge_id,
            deviceId: confirmed.device_id,
            proof: proofFor(box, challenge.payload),
        })).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
        await expect(restarted.issueChallenge({
            deviceId: confirmed.device_id,
            requestedScopes: ['browser:read'],
        })).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
        const again = await restarted.openPairingWindow();
        const repending = await restarted.submitPairing({
            publicKey: box.publicKey,
            name: 'phone-2',
            requestedScopes: ['browser:read'],
        });
        const repaired = await restarted.confirmPairing({
            pendingId: repending.pending_id,
            code: repending.confirmation_code,
            fingerprint: repending.fingerprint,
            grantedScopes: ['browser:read'],
        });
        expect(repaired.device_id).not.toBe(confirmed.device_id);
        expect(repaired.server.public_key).toEqual(confirmed.server.public_key);
        expect(again.window_id).toMatch(/^win_/);
        const saved = JSON.parse(readFileSync(join(box.dirs.state, 'state.json'), 'utf8'));
        expect(saved.gateway_id).toBe('gw_test');
        expect(saved.devices[confirmed.device_id].revoked).toBe(true);
        expect(saved.revocations.some((entry) => entry.device_id === confirmed.device_id)).toBe(true);
        expect(JSON.stringify(saved)).not.toContain('PRIVATE KEY');
    });

    it('fails closed on unsafe storage, corrupt state, locks, and failed writes', async () => {
        const unsafeDir = mkdtempSync(join(tmpdir(), 'agent-auth-unsafe-'));
        cleanups.push(() => removeTree(unsafeDir));
        chmodSync(unsafeDir, 0o770);
        expect(() => createJsonStateStore({ directory: unsafeDir })).toThrow(expect.objectContaining({ code: 'STATE_UNSAFE' }));
        chmodSync(unsafeDir, 0o700);

        const real = mkdtempSync(join(tmpdir(), 'agent-auth-real-'));
        const link = join(real, 'link');
        symlinkSync(unsafeDir, link);
        cleanups.push(() => removeTree(real));
        expect(() => createJsonStateStore({ directory: link })).toThrow(expect.objectContaining({ code: 'STATE_UNSAFE' }));

        const versionDir = mkdtempSync(join(tmpdir(), 'agent-auth-ver-'));
        cleanups.push(() => removeTree(versionDir));
        chmodSync(versionDir, 0o700);
        const versionFile = join(versionDir, 'state.json');
        writeFileSync(versionFile, '{"version":2}\n', { mode: 0o600 });
        const versionStore = createJsonStateStore({ directory: versionDir });
        expect(() => versionStore.load()).toThrow(expect.objectContaining({ code: 'VERSION_UNSUPPORTED' }));
        expect(readFileSync(versionFile, 'utf8')).toBe('{"version":2}\n');
        versionStore.close();

        const box = harness();
        await box.auth.openPairingWindow();
        const statePath = join(box.dirs.state, 'state.json');
        const original = readFileSync(statePath);
        const pending = await box.auth.submitPairing({
            publicKey: box.publicKey,
            name: 'phone',
            requestedScopes: ['browser:read'],
        });
        chmodSync(box.dirs.state, 0o500);
        await expect(box.auth.confirmPairing({
            pendingId: pending.pending_id,
            code: pending.confirmation_code,
            fingerprint: pending.fingerprint,
            grantedScopes: ['browser:read'],
        })).rejects.toMatchObject({ code: 'STATE_UNSAFE' });
        chmodSync(box.dirs.state, 0o700);
        expect(readFileSync(statePath).equals(original)).toBe(true);
        await expect(box.auth.issueChallenge({
            deviceId: 'dev_not_registered',
            requestedScopes: ['browser:read'],
        })).rejects.toMatchObject({ code: 'AUTH_INVALID' });

        box.auth.close();
        writeFileSync(statePath, '{', { mode: 0o600 });
        const broken = createJsonStateStore({ directory: box.dirs.state });
        expect(() => broken.load()).toThrow(expect.objectContaining({ code: 'STATE_UNSAFE' }));
        expect(readFileSync(statePath, 'utf8')).toBe('{');
        broken.close();

        const locked = createJsonStateStore({ directory: box.dirs.state });
        expect(() => createJsonStateStore({ directory: box.dirs.state })).toThrow(expect.objectContaining({ code: 'STATE_UNSAFE' }));
        locked.close();

        const keyFile = join(box.dirs.device, 'device-local.pem');
        const pem = readFileSync(keyFile);
        chmodSync(keyFile, 0o644);
        expect(() => box.deviceKeys.getPublicKey('device-local')).toThrow(expect.objectContaining({ code: 'STATE_UNSAFE' }));
        chmodSync(keyFile, 0o600);
        expect(readFileSync(keyFile).equals(pem)).toBe(true);
        expect(() => box.deviceKeys.getPublicKey('missing-key')).toThrow(expect.objectContaining({ code: 'KEY_UNAVAILABLE' }));
        expect(readFileSync(new URL('../../skills/browser/agent-auth.mjs', import.meta.url), 'utf8').includes('createDevFileKeyStore')).toBe(false);
    });

    it('caps pending registrations and challenge issuance', async () => {
        const box = harness();
        await box.auth.openPairingWindow();
        for (let index = 0; index < 32; index += 1) {
            await box.auth.submitPairing({
                publicKey: box.publicKey,
                name: `phone-${index}`,
                requestedScopes: ['browser:read'],
            });
        }
        await expect(box.auth.submitPairing({
            publicKey: box.publicKey,
            name: 'overflow',
            requestedScopes: ['browser:read'],
        })).rejects.toMatchObject({ code: 'RATE_LIMITED' });

        const limited = harness();
        const paired = await pair(limited);
        for (let index = 0; index < 30; index += 1) {
            await limited.auth.issueChallenge({
                deviceId: paired.confirmed.device_id,
                requestedScopes: ['browser:read'],
            });
        }
        await expect(limited.auth.issueChallenge({
            deviceId: paired.confirmed.device_id,
            requestedScopes: ['browser:read'],
        })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    });

    it('does not write secrets to output or argv', async () => {
        const box = harness();
        const chunks = [];
        const write = process.stdout.write.bind(process.stdout);
        const errorWrite = process.stderr.write.bind(process.stderr);
        const spies = ['log', 'info', 'warn', 'error', 'debug'].map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
        process.stdout.write = (value) => { chunks.push(String(value)); return true; };
        process.stderr.write = (value) => { chunks.push(String(value)); return true; };
        const argv = process.argv.slice();
        try {
            const { pending, confirmed } = await pair(box);
            const challenge = await box.auth.issueChallenge({
                deviceId: confirmed.device_id,
                requestedScopes: ['browser:read'],
            });
            const proof = proofFor(box, challenge.payload);
            const issued = await box.auth.exchangeProof({
                challengeId: challenge.challenge_id,
                deviceId: confirmed.device_id,
                proof,
            });
            const nonce = JSON.parse(Buffer.from(challenge.payload, 'base64url').toString('utf8')).nonce;
            const blob = chunks.join('\n');
            expect(blob.includes(pending.confirmation_code)).toBe(false);
            expect(blob.includes(nonce)).toBe(false);
            expect(blob.includes(proof)).toBe(false);
            expect(blob.includes(issued.token)).toBe(false);
            expect(blob.includes('Authorization')).toBe(false);
            expect(process.argv).toEqual(argv);
            expect(argv.join('\n').includes(issued.token)).toBe(false);
        } finally {
            process.stdout.write = write;
            process.stderr.write = errorWrite;
            for (const spy of spies) spy.mockRestore();
        }
    });

    it('requires https for production transport and explicit loopback for tests', () => {
        expect(() => createHttpsTransport({ origin: 'http://127.0.0.1:7420' })).toThrow(expect.objectContaining({ code: 'AUTH_INVALID' }));
        expect(() => createLoopbackHttpTransport({ baseUrl: 'http://8.8.8.8:7420' })).toThrow(expect.objectContaining({ code: 'AUTH_INVALID' }));
        expect(() => createLoopbackHttpTransport({ baseUrl: 'https://127.0.0.1:443' })).toThrow(expect.objectContaining({ code: 'AUTH_INVALID' }));
        expect(() => createTokenClient({
            transport: { mode: 'http', post: async () => ({}) },
            keyStore: { sign() { return Buffer.alloc(64); } },
            deviceId: 'dev_test',
            pinnedServer: { gateway_id: 'gw_test', audience: AUDIENCE, public_key: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' } },
            scopes: ['browser:read'],
        })).toThrow(expect.objectContaining({ code: 'AUTH_INVALID' }));
        const source = readFileSync(new URL('../../skills/browser/agent-auth.mjs', import.meta.url), 'utf8');
        expect(source.includes('rejectUnauthorized: true')).toBe(true);
        expect(source.includes('rejectUnauthorized: false')).toBe(false);
        expect(existsSync(new URL('../../skills/browser/agent-auth.mjs', import.meta.url))).toBe(true);
        expect(lstatSync(new URL('../../skills/browser/agent-auth-store.mjs', import.meta.url))).toBeTruthy();
    });
});
