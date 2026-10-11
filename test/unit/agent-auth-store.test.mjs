import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevFileKeyStore } from '../../skills/browser/agent-auth-store.mjs';

const roots = [];

afterEach(() => {
    vi.restoreAllMocks();
    while (roots.length > 0) {
        const root = roots.pop();
        try { chmodSync(root, 0o700); } catch { /* already removed */ }
        rmSync(root, { recursive: true, force: true });
    }
});

function keyDirectory() {
    const root = mkdtempSync(join(tmpdir(), 'agent-auth-store-lock-'));
    roots.push(root);
    const directory = join(root, 'keys');
    return { directory, lockPath: join(directory, '.writer.lock') };
}

describe('agent auth store writer lock', () => {
    it('writes its PID to the lock and removes its own lock on close', () => {
        const paths = keyDirectory();
        const store = createDevFileKeyStore({ directory: paths.directory });

        expect(readFileSync(paths.lockPath, 'utf8')).toBe(`${process.pid}\n`);
        expect(lstatSync(paths.lockPath).mode & 0o777).toBe(0o600);
        store.close();
        expect(readdirSync(paths.directory)).toEqual([]);
    });

    it('reports an ESRCH owner as stale and leaves the exact lock file untouched', () => {
        const paths = keyDirectory();
        const initial = createDevFileKeyStore({ directory: paths.directory });
        initial.close();
        writeFileSync(paths.lockPath, '2147483647\n', { mode: 0o600 });
        chmodSync(paths.lockPath, 0o600);
        const original = lstatSync(paths.lockPath);
        vi.spyOn(process, 'kill').mockImplementation(() => {
            throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
        });

        let failure;
        try {
            createDevFileKeyStore({ directory: paths.directory });
        } catch (error) {
            failure = error;
        }

        expect(failure).toMatchObject({ code: 'STATE_LOCK_STALE' });
        expect(failure.message).toBe(`The writer lock owner is no longer running. Remove "${paths.lockPath}" manually before retrying.`);
        expect(lstatSync(paths.lockPath).ino).toBe(original.ino);
        expect(readFileSync(paths.lockPath, 'utf8')).toBe('2147483647\n');
        expect(readdirSync(paths.directory)).toEqual(['.writer.lock']);
    });

    it('keeps a lock owned by a live process exclusive and unchanged', () => {
        const paths = keyDirectory();
        const initial = createDevFileKeyStore({ directory: paths.directory });
        initial.close();
        writeFileSync(paths.lockPath, `${process.pid}\n`, { mode: 0o600 });
        chmodSync(paths.lockPath, 0o600);
        const original = lstatSync(paths.lockPath);

        expect(() => createDevFileKeyStore({ directory: paths.directory }))
            .toThrow(expect.objectContaining({ code: 'STATE_UNSAFE' }));
        expect(lstatSync(paths.lockPath).ino).toBe(original.ino);
        expect(readFileSync(paths.lockPath, 'utf8')).toBe(`${process.pid}\n`);
    });
});
