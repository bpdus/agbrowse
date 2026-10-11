import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthService } from '../../skills/browser/agent-auth.mjs';
import { createDevFileKeyStore, createJsonStateStore } from '../../skills/browser/agent-auth-store.mjs';
import { createGateway } from '../../skills/browser/agent-gateway.mjs';
import { MCP_PROTOCOL_VERSION } from '../../skills/browser/agent-mcp.mjs';
import {
    assertGatewayUrl,
    bootstrapLocalClient,
    connectMcpHttp,
    createClientStore,
    runMcpStdioClient,
} from '../../skills/browser/agent-mcp-client.mjs';

const cleanups = [];
const gateways = [];

afterEach(async () => {
    while (gateways.length > 0) {
        try { await gateways.pop().stop(); } catch { /* already stopped */ }
    }
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

function harness(audience) {
    const root = mkdtempSync(join(tmpdir(), 'agent-mcp-client-'));
    const dirs = {
        state: join(root, 'state'),
        server: join(root, 'server-keys'),
        device: join(root, 'device-keys'),
    };
    let ms = Date.now();
    const stateStore = createJsonStateStore({ directory: dirs.state });
    const keyStore = createDevFileKeyStore({ directory: dirs.server });
    const deviceKeys = createDevFileKeyStore({ directory: dirs.device });
    const auth = createAuthService({
        stateStore,
        keyStore,
        gatewayId: 'gw_test',
        audience,
        now: () => ms,
    });
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
        deviceKeys,
        now: () => ms,
        advance(seconds) { ms += seconds * 1000; },
    };
}

function reservePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = address && typeof address === 'object' ? address.port : 0;
            server.close((error) => (error ? reject(error) : resolve(port)));
        });
    });
}

function capture() {
    let text = '';
    return {
        stream: {
            write(chunk) {
                text += String(chunk);
                return true;
            },
        },
        read: () => text,
    };
}

async function liveGateway() {
    const port = await reservePort();
    const audience = `http://127.0.0.1:${port}/mcp`;
    const box = harness(audience);
    const calls = [];
    const logs = [];
    const seen = [];
    const authenticate = box.auth.authenticate.bind(box.auth);
    box.auth.authenticate = async (token) => {
        seen.push(token);
        return authenticate(token);
    };
    const gateway = createGateway({
        auth: box.auth,
        worker: {
            async call(op, payload) {
                calls.push({ op, payload });
                return { worker_id: `wrk_${'ab'.repeat(8)}` };
            },
        },
        port,
        allowedHosts: [`127.0.0.1:${port}`],
        log: (line) => logs.push(line),
    });
    await gateway.start();
    gateways.push(gateway);
    return { port, audience, box, calls, logs, seen };
}

describe('agent mcp client', () => {
    it('accepts only a pinned loopback or https gateway origin', () => {
        expect(assertGatewayUrl('http://127.0.0.1:7420', 'http://127.0.0.1:7420/mcp')).toBe('http://127.0.0.1:7420');
        expect(assertGatewayUrl('https://gw.example', 'https://gw.example/mcp')).toBe('https://gw.example');
        expect(() => assertGatewayUrl('http://evil.example', 'http://evil.example/mcp')).toThrow(expect.objectContaining({ code: 'AUTH_INVALID' }));
        expect(() => assertGatewayUrl('http://127.0.0.1:7420', 'http://127.0.0.1:7421/mcp')).toThrow(expect.objectContaining({ code: 'AUTH_INVALID' }));
        expect(() => assertGatewayUrl('http://user:pass@127.0.0.1:7420', 'http://127.0.0.1:7420/mcp')).toThrow(expect.objectContaining({ code: 'AUTH_INVALID' }));
        expect(() => assertGatewayUrl('http://127.0.0.1:7420/?q=secret', 'http://127.0.0.1:7420/mcp')).toThrow(expect.objectContaining({ code: 'AUTH_INVALID' }));
        expect(() => assertGatewayUrl('http://127.0.0.1:7420', 'http://127.0.0.1:7420/healthz')).toThrow(expect.objectContaining({ code: 'AUTH_INVALID' }));
    });

    it('bootstraps a client record without returning the confirmation code', async () => {
        const audience = 'http://127.0.0.1:7420/mcp';
        const box = harness(audience);
        const codes = [];
        const confirm = box.auth.confirmPairing.bind(box.auth);
        box.auth.confirmPairing = async (input) => {
            codes.push(input.code);
            return confirm(input);
        };
        const clientDir = join(box.root, 'client');
        const result = await bootstrapLocalClient({
            auth: box.auth,
            deviceKeys: box.deviceKeys,
            directory: clientDir,
            name: 'local',
        });
        expect(Object.keys(result)).toEqual(['device_id']);
        expect(codes[0]).toEqual(expect.any(String));
        expect(codes[0].length).toBeGreaterThan(0);
        expect(JSON.stringify(result)).not.toContain(codes[0]);
        const filePath = join(clientDir, 'client.json');
        const raw = readFileSync(filePath, 'utf8');
        expect(raw).not.toContain(codes[0]);
        expect(raw).not.toContain('confirmation_code');
        expect(lstatSync(clientDir).mode & 0o777).toBe(0o700);
        expect(lstatSync(filePath).mode & 0o777).toBe(0o600);
        const record = createClientStore({ directory: clientDir }).load();
        expect(record.device_id).toBe(result.device_id);
        expect(record.key_id).toBe('mcp-client');
        expect(record.audience).toBe(audience);
        expect(record.scopes).toEqual(['browser:read']);
    });

    it('renews a loopback token and reports revocation without echoing it', async () => {
        const { port, box, calls, logs, seen } = await liveGateway();
        const clientDir = join(box.root, 'client');
        const paired = await bootstrapLocalClient({
            auth: box.auth,
            deviceKeys: box.deviceKeys,
            directory: clientDir,
        });
        const record = createClientStore({ directory: clientDir }).load();
        const client = connectMcpHttp({
            record,
            keyStore: box.deviceKeys,
            gatewayUrl: `http://127.0.0.1:${port}`,
            now: () => box.now(),
        });
        try {
            const init = await client.request({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'unit', version: '0' } },
            });
            expect(init.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
            expect(calls).toEqual([]);
            expect(seen).toHaveLength(1);

            box.advance(241);
            const listed = await client.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
            expect(listed.result.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
                'browser.session.open',
                'naver.search.list',
                'naver.search.result.read',
            ]));
            expect(seen).toHaveLength(2);
            expect(seen[1]).not.toBe(seen[0]);

            await box.auth.revokeDevice(paired.device_id);
            const failed = await client.request({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
            expect(failed.error).toMatchObject({ code: -32000, data: { code: 'DEVICE_REVOKED' } });
            expect(seen).toHaveLength(3);
            expect(seen[2]).toBe(seen[1]);
            const dumped = `${JSON.stringify(failed)}\n${logs.join('')}`;
            expect(dumped).not.toContain(seen[0]);
            expect(dumped).not.toContain(seen[1]);
            expect(calls).toEqual([]);
        } finally {
            client.close();
        }
    });

    it('keeps stdout to MCP messages and rejects secret arguments', async () => {
        const helpOut = capture();
        const helpErr = capture();
        let helpCode = null;
        const helped = await runMcpStdioClient({
            argv: ['--help'],
            stdout: helpOut.stream,
            stderr: helpErr.stream,
            exit(code) { helpCode = code; },
        });
        expect(helped).toBe(0);
        expect(helpCode).toBe(0);
        expect(helpErr.read()).toBe('');
        expect(helpOut.read()).toContain('Stdout contains MCP messages only.');
        expect(helpOut.read()).not.toMatch(/canary-secret-value|confirmation_code/);

        for (const flag of ['--token', '--query', '--secret']) {
            const stdout = capture();
            const stderr = capture();
            let code = null;
            const status = await runMcpStdioClient({
                argv: [flag, 'canary-secret-value'],
                stdout: stdout.stream,
                stderr: stderr.stream,
                exit(value) { code = value; },
            });
            expect(status).toBe(1);
            expect(code).toBe(1);
            expect(stdout.read()).toBe('');
            expect(stderr.read()).toBe('agbrowse-mcp-client: error code=INVALID_ARGUMENTS\n');
            expect(stderr.read()).not.toContain('canary-secret-value');
        }
    });

    it('speaks initialize over stdio without printing the access token', async () => {
        const { port, box, calls, seen } = await liveGateway();
        const clientDir = join(box.root, 'client');
        await bootstrapLocalClient({
            auth: box.auth,
            deviceKeys: box.deviceKeys,
            directory: clientDir,
        });
        box.deviceKeys.close();
        const stdout = capture();
        const stderr = capture();
        const init = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'stdio', version: '0' } },
        });
        const note = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
        const list = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        let code = null;
        const status = await runMcpStdioClient({
            argv: ['--client-dir', clientDir, '--key-dir', box.dirs.device, '--gateway-url', `http://127.0.0.1:${port}`],
            stdin: Readable.from([`${init}\n${note}\n${list}\n`]),
            stdout: stdout.stream,
            stderr: stderr.stream,
            exit(value) { code = value; },
        });
        expect(status).toBe(0);
        expect(code).toBe(0);
        expect(stderr.read()).toBe('');
        const lines = stdout.read().trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(JSON.parse(lines[0]).result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
        expect(JSON.parse(lines[1]).result.tools.length).toBeGreaterThan(0);
        expect(stdout.read()).not.toContain(seen[0]);
        expect(calls).toEqual([]);
    });
});
