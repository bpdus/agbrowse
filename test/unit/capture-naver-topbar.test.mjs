import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runNaverTopbarCapture } from '../../bin/bpdus/capture-naver-topbar.mjs';

const roots = [];

afterEach(() => {
    while (roots.length > 0) {
        const root = roots.pop();
        try { chmodSync(root, 0o700); } catch { /* already removed */ }
        rmSync(root, { recursive: true, force: true });
    }
});

function capture() {
    let text = '';
    return {
        stream: { write(chunk) { text += String(chunk); return true; } },
        read: () => text,
    };
}

describe('capture-naver-topbar CLI', () => {
    it('writes mode 0600 output and prints only its byte count', async () => {
        const root = mkdtempSync(join(tmpdir(), 'agent-topbar-cli-'));
        roots.push(root);
        const output = join(root, 'capture.html');
        const stdout = capture();
        const stderr = capture();
        let closed = 0;

        const status = await runNaverTopbarCapture({
            argv: ['--out', output],
            stdout: stdout.stream,
            stderr: stderr.stream,
            connect: () => ({
                async call(op, payload) {
                    expect(op).toBe('operator.naver.topbar_structure');
                    expect(payload).toEqual({});
                    return '<header>TEXT</header>';
                },
                close() { closed += 1; },
            }),
        });

        const bytes = readFileSync(output);
        expect(status).toBe(0);
        expect(bytes.toString()).toBe('<header>TEXT</header>');
        expect(lstatSync(output).mode & 0o777).toBe(0o600);
        expect(stdout.read()).toBe(`${bytes.length}\n`);
        expect(stderr.read()).toBe('');
        expect(closed).toBe(1);
    });
});
