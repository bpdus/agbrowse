import { spawn } from 'node:child_process';
import * as http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signCompactJws } from '../../skills/browser/agent-auth.mjs';
import { createDevFileKeyStore, createJsonStateStore } from '../../skills/browser/agent-auth-store.mjs';
import { createAuthService } from '../../skills/browser/agent-auth.mjs';
import { createGateway } from '../../skills/browser/agent-gateway.mjs';

const AUDIENCE = 'https://gw.example/mcp';
const CHALLENGE_HEADER = '{"alg":"ES256","typ":"paired-device-v1+challenge"}';
const SCRIPT = fileURLToPath(new URL('../../skills/browser/agent-gateway.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const cleanups = [];

afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()();
});

function track(root, ...resources) {
    cleanups.push(async () => {
        for (const resource of resources) {
            try { await resource.stop?.(); } catch { /* already stopped */ }
            try { await resource.close?.(); } catch { /* already closed */ }
            try { resource.close?.(); } catch { /* sync close */ }
        }
        rmSync(root, { recursive: true, force: true });
    });
}

function request(port, { path = '/healthz', method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path,
            method,
            headers,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

async function listenGateway() {
    const root = mkdtempSync(join(tmpdir(), 'agent-gateway-'));
    const stateStore = createJsonStateStore({ directory: join(root, 'state') });
    const keyStore = createDevFileKeyStore({ directory: join(root, 'server-keys') });
    const deviceKeys = createDevFileKeyStore({ directory: join(root, 'device-keys') });
    const auth = createAuthService({
        stateStore,
        keyStore,
        gatewayId: 'gw_test',
        audience: AUDIENCE,
    });
    const gateway = createGateway({
        auth,
        port: 0,
        allowedHosts: ['127.0.0.1:0'],
        allowedOrigins: ['https://ops.example'],
    });
    track(root, gateway, auth, deviceKeys);
    expect(gateway.address()).toBeNull();
    await gateway.start();
    const bound = gateway.address();
    return { gateway, auth, deviceKeys, port: bound.port, address: bound.address };
}

function runEntry(args) {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    cleanups.push(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGTERM');
            await new Promise((resolve) => child.once('exit', resolve));
        }
    });
    return {
        child,
        output: () => ({ stdout, stderr }),
        exited: new Promise((resolve) => child.once('exit', (code) => resolve(code))),
    };
}

describe('loopback auth gateway', () => {
    it('serves the credential form and enforces exact origin without reflecting submitted secrets', async () => {
        const root = mkdtempSync(join(tmpdir(), 'agent-gateway-creds-'));
        const auth = createAuthService({ stateStore: createJsonStateStore({ directory: join(root, 'state') }), keyStore: createDevFileKeyStore({ directory: join(root, 'keys') }), gatewayId: 'gw_creds', audience: AUDIENCE });
        const saves = [];
        const gateway = createGateway({ auth, port: 0, allowedHosts: ['127.0.0.1:0'], allowedOrigins: ['https://jjbyuns-imac.tail8f1886.ts.net:8443'], credentials: { consume: async (token) => token === 'token-sentinel' }, credentialsWorker: { call: async (_op, payload) => { saves.push(payload); return { result: 'saved' }; } } });
        track(root, gateway, auth); await gateway.start(); const port = gateway.address().port; const host = `127.0.0.1:${port}`;
        const page = await request(port, { path: '/admin/naver-credentials', headers: { host } });
        expect(page.status).toBe(200); expect(page.headers['cache-control']).toBe('no-store'); expect(page.headers['referrer-policy']).toBe('no-referrer');
        const payload = new URLSearchParams({ token: 'token-sentinel', account: 'id-sentinel', password: 'pw-sentinel' }).toString();
        const submit = (origin) => request(port, { path: '/admin/naver-credentials', method: 'POST', headers: { host, ...(origin ? { origin } : {}), 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(payload) }, body: payload });
        const denied = await submit('https://evil.example'); expect(denied.status).toBe(403); expect(denied.body).not.toContain('sentinel');
        const missingOrigin = await submit(undefined); expect(missingOrigin.status).toBe(403);
        const oversizedBody = 'x'.repeat(16 * 1024 + 1);
        const oversized = await request(port, { path: '/admin/naver-credentials', method: 'POST', headers: { host, origin: 'https://jjbyuns-imac.tail8f1886.ts.net:8443', 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(oversizedBody) }, body: oversizedBody });
        expect(oversized.status).toBe(413); expect(oversized.headers['content-security-policy']).toContain("default-src 'none'");
        const accepted = await submit('https://jjbyuns-imac.tail8f1886.ts.net:8443');
        expect(accepted.status).toBe(200); expect(accepted.body).toBe('saved'); expect(accepted.body).not.toContain('sentinel');
        expect(saves).toEqual([{ account: 'id-sentinel', password: 'pw-sentinel' }]);
        for (let index = 0; index < 4; index += 1) await submit('https://jjbyuns-imac.tail8f1886.ts.net:8443');
        expect((await submit('https://jjbyuns-imac.tail8f1886.ts.net:8443')).status).toBe(429);
    });

    it('listens only after start and only on 127.0.0.1', async () => {
        expect(() => createGateway({
            auth: { submitPairing() {}, issueChallenge() {}, exchangeProof() {} },
            port: 0,
            host: '0.0.0.0',
            allowedHosts: ['127.0.0.1:0'],
        })).toThrow(expect.objectContaining({ code: 'AUTH_INVALID' }));
        const started = await listenGateway();
        expect(started.address).toBe('127.0.0.1');
        const health = await request(started.port);
        expect(health.status).toBe(200);
        expect(health.body).toBe('{"ok":true}');
        expect(health.headers['access-control-allow-origin']).toBeUndefined();
        await started.gateway.stop();
        await started.gateway.stop();
        await expect(request(started.port)).rejects.toThrow();
    });

    it('enforces host, origin, size, and route limits', async () => {
        const started = await listenGateway();
        const { port, auth, deviceKeys } = started;
        const host = `127.0.0.1:${port}`;
        const publicKey = deviceKeys.ensureKey('device-local');
        await auth.openPairingWindow();
        const pairBody = JSON.stringify({
            protocol_version: '0.1.0',
            public_key: publicKey,
            name: 'phone',
            requested_scopes: ['browser:read'],
        });
        const badHost = await request(port, {
            path: '/auth/pair',
            method: 'POST',
            headers: {
                host: 'evil.test',
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(pairBody),
            },
            body: pairBody,
        });
        expect(badHost.status).toBe(403);
        expect(badHost.body).not.toContain('evil.test');
        expect(badHost.headers['access-control-allow-origin']).toBeUndefined();

        const badOrigin = await request(port, {
            path: '/healthz',
            headers: { host, origin: 'https://evil.example' },
        });
        expect(badOrigin.status).toBe(403);
        expect(badOrigin.body).not.toContain('evil.example');

        const paired = await request(port, {
            path: '/auth/pair',
            method: 'POST',
            headers: {
                host,
                origin: 'https://ops.example',
                'content-type': 'application/json; charset=utf-8',
                'content-length': Buffer.byteLength(pairBody),
            },
            body: pairBody,
        });
        expect(paired.status).toBe(200);
        const pending = JSON.parse(paired.body);
        const confirmed = await auth.confirmPairing({
            pendingId: pending.pending_id,
            code: pending.confirmation_code,
            fingerprint: pending.fingerprint,
            grantedScopes: ['browser:read'],
        });

        const challengeBody = JSON.stringify({
            protocol_version: '0.1.0',
            device_id: confirmed.device_id,
            requested_scopes: ['browser:read'],
        });
        const challenged = await request(port, {
            path: '/auth/challenge',
            method: 'POST',
            headers: {
                host,
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(challengeBody),
                'tailscale-user-login': 'SECRET-FIXTURE-LOGIN',
                authorization: 'Bearer SECRET-FIXTURE-TOKEN',
            },
            body: challengeBody,
        });
        expect(challenged.status).toBe(200);
        expect(challenged.body).not.toContain('SECRET-FIXTURE-LOGIN');
        expect(challenged.body).not.toContain('SECRET-FIXTURE-TOKEN');
        const challenge = JSON.parse(challenged.body);
        const proof = signCompactJws(deviceKeys, 'device-local', CHALLENGE_HEADER, Buffer.from(challenge.payload, 'base64url'));
        const tokenBody = JSON.stringify({
            protocol_version: '0.1.0',
            challenge_id: challenge.challenge_id,
            device_id: confirmed.device_id,
            proof,
        });
        const issued = await request(port, {
            path: '/auth/token',
            method: 'POST',
            headers: {
                host,
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(tokenBody),
            },
            body: tokenBody,
        });
        expect(issued.status).toBe(200);
        expect((await auth.authenticate(JSON.parse(issued.body).token)).device_id).toBe(confirmed.device_id);

        const marker = `SECRET-BODY-MARKER${'x'.repeat(16 * 1024)}`;
        const oversized = await request(port, {
            path: '/auth/pair',
            method: 'POST',
            headers: {
                host,
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(marker),
            },
            body: marker,
        });
        expect(oversized.status).toBe(413);
        expect(oversized.body).not.toContain('SECRET-BODY-MARKER');

        const plain = await request(port, {
            path: '/auth/token',
            method: 'POST',
            headers: { host, 'content-type': 'text/plain', 'content-length': '2' },
            body: '{}',
        });
        expect(plain.status).toBe(415);
        const mcp = await request(port, { path: '/mcp', method: 'POST', headers: { host } });
        expect(mcp.status).toBe(401);
        expect(JSON.parse(mcp.body).error.code).toBe('AUTH_INVALID');
        expect((await request(port, { path: '/auth/pair', method: 'GET', headers: { host } })).status).toBe(405);
        expect((await request(port, { path: '/healthz?x=1', headers: { host } })).status).toBe(404);
        const source = readFileSync(SCRIPT, 'utf8');
        expect(source.includes('agent-runtime')).toBe(false);
        expect(source.includes('playwright')).toBe(false);
        expect(source.includes('child_process')).toBe(false);
    });

    it('starts the foreground entry on loopback and rejects other bind addresses', async () => {
        const spies = ['log', 'info', 'warn', 'error', 'debug'].map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
        try {
            const help = runEntry(['--help']);
            expect(await help.exited).toBe(0);
            expect(help.output().stdout).toContain('7420');
            expect(help.output().stdout).toContain('/healthz');
            expect(help.output().stdout).toContain('127.0.0.1');

            const rejected = runEntry(['--host', '0.0.0.0', '--port', '7420']);
            expect(await rejected.exited).toBe(1);
            expect(rejected.output().stderr).toContain('AUTH_INVALID');
            expect(rejected.output().stdout).not.toContain('listening');

            const child = runEntry(['--port', '0']);
            const line = await vi.waitFor(() => {
                const text = child.output().stdout;
                expect(text).toMatch(/listening host=127\.0\.0\.1 port=\d+/);
                return text;
            });
            const port = Number(line.match(/port=(\d+)/)[1]);
            const health = await request(port);
            expect(health.body).toBe('{"ok":true}');
            expect(child.output().stdout.includes('SECRET-FIXTURE-TOKEN')).toBe(false);
            expect(child.output().stderr.includes('Authorization')).toBe(false);
            child.child.kill('SIGTERM');
            expect(await child.exited).toBe(0);
            expect(child.output().stdout).toContain('stopped');
        } finally {
            for (const spy of spies) spy.mockRestore();
        }
    });

    it('leaves bootstrap routes open and requires a token everywhere else', async () => {
        const started = await listenGateway();
        const host = `127.0.0.1:${started.port}`;
        const health = await request(started.port, { headers: { host } });
        expect(health.status).toBe(200);
        expect(health.body).toBe('{"ok":true}');
        expect(Object.keys(JSON.parse(health.body))).toEqual(['ok']);
        expect(health.body).not.toMatch(/version|device|path/i);

        expect((await request(started.port, { path: '/healthz', method: 'POST', headers: { host } })).status).toBe(405);
        for (const path of ['/auth/pair', '/auth/challenge', '/auth/token']) {
            const posted = await request(started.port, { path, method: 'POST', headers: { host } });
            expect(posted.status).toBe(415);
            const got = await request(started.port, { path, method: 'GET', headers: { host } });
            expect(got.status).toBe(405);
        }

        for (const path of ['/mcp', '/snapshot', '/browser', '/auth/revoke', '/version', '/debug', '/readyz', '/', '/auth/pair/extra']) {
            for (const method of ['GET', 'POST']) {
                const closed = await request(started.port, { path, method, headers: { host } });
                expect(closed.status).toBe(401);
                expect(JSON.parse(closed.body).error.code).toBe('AUTH_INVALID');
                expect(closed.body).not.toMatch(/version|device|path/i);
            }
        }

        const canary = 'canary-secret-token.aaa.bbb';
        const rejected = await request(started.port, {
            path: '/version',
            method: 'GET',
            headers: { host, authorization: `Bearer ${canary}` },
        });
        expect(rejected.status).toBe(401);
        expect(JSON.parse(rejected.body).error.code).toBe('AUTH_INVALID');
        expect(rejected.body).not.toContain('canary-secret-token');
    });
});
