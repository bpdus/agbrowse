import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { connectReadEndpoint, defaultSocketPath, startReadEndpoint } from '../../skills/browser/agent-ipc.mjs';

const sockets = [];

afterEach(async () => {
    while (sockets.length > 0) {
        const item = sockets.pop();
        try { item.client?.close(); } catch { /* already closed */ }
        try { await item.endpoint?.close(); } catch { /* already closed */ }
        if (item.dir) rmSync(item.dir, { recursive: true, force: true });
    }
});

function socketDir() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agb-ipc-')));
    chmodSync(dir, 0o700);
    return dir;
}

describe('agent ipc', () => {
    it('uses the fixed socket name under the dedicated home directory', async () => {
        expect(defaultSocketPath('/home/someone')).toBe('/home/someone/.agbrowse-bpdus/agent-worker.sock');
        await expect(startReadEndpoint({
            socketPath: '/tmp/not-the-agent-socket',
            dispatch: async () => ({}),
        })).rejects.toMatchObject({ code: 'STATE_UNSAFE' });
    });

    it('answers hello itself and does not log payloads', async () => {
        const dir = socketDir();
        const socketPath = join(dir, 'agent-worker.sock');
        const logs = [];
        const seen = [];
        const endpoint = await startReadEndpoint({
            socketPath,
            log: (line) => logs.push(line),
            async dispatch(op, payload) {
                seen.push({ op, payload });
                if (payload.boom) {
                    const error = new Error('super-secret-cookie-value');
                    error.code = 'SESSION_NOT_FOUND';
                    throw error;
                }
                return { echoed: payload.query };
            },
        });
        const client = connectReadEndpoint({ socketPath });
        sockets.push({ endpoint, client, dir });
        const stat = lstatSync(socketPath);
        expect(stat.isSocket()).toBe(true);
        expect(stat.mode & 0o777).toBe(0o600);

        const hello = await client.call('worker.hello', { query: 'canary-secret-value' });
        expect(hello.worker_id).toMatch(/^wrk_[a-f0-9]{16}$/);
        expect(seen).toEqual([]);

        const observed = await client.call('browser.observe', { query: 'canary-secret-value' });
        expect(observed.echoed).toBe('canary-secret-value');
        expect(seen).toEqual([{ op: 'browser.observe', payload: { query: 'canary-secret-value' } }]);
        expect(logs.join('')).not.toContain('canary-secret-value');
        expect(logs.some((line) => line.startsWith('agbrowse-worker: op=browser.observe status=ok '))).toBe(true);

        await expect(client.call('browser.click', {})).rejects.toMatchObject({ code: 'ACTION_DENIED' });
        await expect(client.call('browser.observe', { boom: true })).rejects.toMatchObject({
            code: 'SESSION_NOT_FOUND',
            message: 'Session was not found.',
        });
        expect(logs.join('')).not.toContain('super-secret-cookie-value');

        chmodSync(socketPath, 0o666);
        const loose = connectReadEndpoint({ socketPath });
        await expect(loose.call('worker.hello', {})).rejects.toMatchObject({ code: 'STATE_UNSAFE' });
        loose.close();
    });

    it('rejects a symlink, a missing socket, and a second worker', async () => {
        const dir = socketDir();
        const socketPath = join(dir, 'agent-worker.sock');
        const target = join(dir, 'other');
        writeFileSync(target, '');
        symlinkSync(target, socketPath);
        await expect(startReadEndpoint({
            socketPath,
            dispatch: async () => ({}),
        })).rejects.toMatchObject({ code: 'STATE_UNSAFE' });
        expect(lstatSync(socketPath).isSymbolicLink()).toBe(true);
        rmSync(socketPath);

        const missing = connectReadEndpoint({ socketPath });
        await expect(missing.call('worker.hello', {})).rejects.toMatchObject({ code: 'NOT_RUNNING' });
        missing.close();

        const endpoint = await startReadEndpoint({ socketPath, dispatch: async () => ({ ok: true }) });
        sockets.push({ endpoint, dir });
        await expect(startReadEndpoint({
            socketPath,
            dispatch: async () => ({ ok: true }),
        })).rejects.toMatchObject({ code: 'ALREADY_RUNNING' });
        await endpoint.close();
        expect(existsSync(socketPath)).toBe(false);
    });

    it('rejects a symlinked parent directory', async () => {
        const dir = socketDir();
        const actual = join(dir, 'actual');
        mkdirSync(actual, { mode: 0o700 });
        const link = join(dir, 'link');
        symlinkSync(actual, link);
        await expect(startReadEndpoint({
            socketPath: join(link, 'agent-worker.sock'),
            dispatch: async () => ({}),
        })).rejects.toMatchObject({ code: 'STATE_UNSAFE' });
        rmSync(dir, { recursive: true, force: true });
    });
});
