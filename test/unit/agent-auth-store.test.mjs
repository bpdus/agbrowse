import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDevFileKeyStore } from '../../skills/browser/agent-auth-store.mjs';

const roots = [];

afterEach(() => {
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
    return { root, directory, lockPath: join(directory, '.writer.lock') };
}

describe('agent auth store writer lock', () => {
    it('recovers an owned mode 0600 lock whose PID is gone and records the new owner', () => {
        const paths = keyDirectory();
        const initial = createDevFileKeyStore({ directory: paths.directory });
        initial.close();
        writeFileSync(paths.lockPath, '2147483647\n', { mode: 0o600 });
        chmodSync(paths.lockPath, 0o600);

        const recovered = createDevFileKeyStore({ directory: paths.directory });
        expect(readFileSync(paths.lockPath, 'utf8')).toBe(`${process.pid}\n`);
        expect(lstatSync(paths.lockPath).mode & 0o777).toBe(0o600);
        recovered.ensureKey('lock-test');
        recovered.close();
    });

    it('keeps a lock owned by a live PID exclusive', () => {
        const paths = keyDirectory();
        const initial = createDevFileKeyStore({ directory: paths.directory });
        initial.close();
        writeFileSync(paths.lockPath, `${process.pid}\n`, { mode: 0o600 });
        chmodSync(paths.lockPath, 0o600);

        expect(() => createDevFileKeyStore({ directory: paths.directory }))
            .toThrow(expect.objectContaining({ code: 'STATE_UNSAFE' }));
        expect(readFileSync(paths.lockPath, 'utf8')).toBe(`${process.pid}\n`);
    });
});
