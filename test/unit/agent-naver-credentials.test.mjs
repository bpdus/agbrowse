import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createNaverCredentialStore, encodeSecurityArgument } from '../../skills/browser/agent-naver-credentials.mjs';

function spawnStub(exit = 0, stdout = '') {
    const calls = [];
    const spawn = (bin, args, opts) => {
        calls.push({ bin, args, opts });
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = { end: (input) => { calls.at(-1).input = input; } };
        child.kill = vi.fn();
        queueMicrotask(() => { if (stdout) child.stdout.emit('data', stdout); child.emit('close', exit); });
        return child;
    };
    return { spawn, calls };
}

describe('Naver credential store', () => {
    it('uses interactive fixed argv and writes private account only after success', async () => {
        const home = mkdtempSync(path.join(os.tmpdir(), 'agbrowse-creds-'));
        const fake = spawnStub();
        try {
            const store = createNaverCredentialStore({ home, spawn: fake.spawn });
            expect(await store.saveCredentials('user"\n-id', 'p\\"ass')).toEqual({ result: 'failed', reason: 'invalid_input' });
            expect(await store.saveCredentials('user"-id', 'p\\"ass')).toEqual({ result: 'saved' });
            expect(fake.calls[0].args).toEqual(['-i', '-q']);
            expect(fake.calls[0].opts.shell).toBe(false);
            expect(fake.calls[0].opts.stdio).toEqual(['pipe', 'ignore', 'ignore']);
            expect(fake.calls[0].input).toContain('add-generic-password -U -s agbrowse.naver');
            expect(fake.calls[0].input).toContain('user\\"-id');
            const file = path.join(home, '.agbrowse-bpdus/state/naver-account');
            expect(readFileSync(file, 'utf8')).toBe('user"-id');
            expect(statSync(file).mode & 0o777).toBe(0o600);
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
    it('sanitizes failed writes and rejects unsafe tokenizer input', async () => {
        const home = mkdtempSync(path.join(os.tmpdir(), 'agbrowse-creds-'));
        try {
            const failed = createNaverCredentialStore({ home, spawn: spawnStub(1).spawn });
            expect(await failed.saveCredentials('first', 'private-sentinel')).toEqual({ result: 'failed', reason: 'keychain_write_failed' });
            expect(() => encodeSecurityArgument('bad\rvalue')).toThrow();
            expect(() => encodeSecurityArgument('bad\0value')).toThrow();
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
    it('keeps the previous account when an update fails and reads only one trailing output newline', async () => {
        const home = mkdtempSync(path.join(os.tmpdir(), 'agbrowse-creds-'));
        let writes = 0;
        const callArgs = [];
        const spawn = (bin, args, opts) => {
            callArgs.push(args);
            if (args[0] === '-i') {
                writes += 1;
                const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = { end() {} }; child.kill = vi.fn();
                queueMicrotask(() => child.emit('close', writes === 1 ? 0 : 1));
                return child;
            }
            return spawnStub(0, 'secret-sentinel\n\n').spawn(bin, args, opts);
        };
        try {
            const store = createNaverCredentialStore({ home, spawn, timeoutMs: 20 });
            expect(await store.saveCredentials('old-id', 'old-password')).toEqual({ result: 'saved' });
            expect(await store.saveCredentials('new-id', 'new-password')).toEqual({ result: 'failed', reason: 'keychain_write_failed' });
            expect(readFileSync(path.join(home, '.agbrowse-bpdus/state/naver-account'), 'utf8')).toBe('old-id');
            const read = await store.readCredentials('id-argv-only');
            expect(read).toEqual({ result: 'credentials', account: 'id-argv-only', password: 'secret-sentinel\n' });
            expect(JSON.stringify(callArgs)).not.toContain('old-password');
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
    it('maps a hung security process to a fixed timeout failure', async () => {
        const home = mkdtempSync(path.join(os.tmpdir(), 'agbrowse-creds-'));
        const spawn = (_bin, _args, _opts) => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stdin = { end() {} }; child.kill = vi.fn(); return child; };
        try { expect(await createNaverCredentialStore({ home, spawn, timeoutMs: 5 }).saveCredentials('id', 'password')).toEqual({ result: 'failed', reason: 'keychain_write_failed' }); }
        finally { rmSync(home, { recursive: true, force: true }); }
    });
});
