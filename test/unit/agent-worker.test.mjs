import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    created: 0,
    factory() {
        throw new Error('factory not set');
    },
}));

vi.mock('../../skills/browser/agent-runtime.mjs', () => ({
    createAgentRuntime(config) {
        harness.created += 1;
        return harness.factory(config);
    },
}));

const { runAgentWorker } = await import('../../skills/browser/agent-worker.mjs');

const workerSource = readFileSync(new URL('../../skills/browser/agent-worker.mjs', import.meta.url), 'utf8');
const createdAtImport = harness.created;
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const workerScript = fileURLToPath(new URL('../../skills/browser/agent-worker.mjs', import.meta.url));
const SECRETS = [
    'super-secret-cookie-value',
    'https://evil.example/private?token=sekret',
    '/tmp/secret-profile',
    'SECRET_DEBUG_TOKEN',
    'legacy-secret-home',
    '--remote-debugging-port=9222',
];
const ENV_KEYS = ['DEBUG', 'PWDEBUG', 'DEBUG_FILE', 'BROWSER_AGENT_HOME'];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
    for (const key of ENV_KEYS) {
        const value = ORIGINAL_ENV[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
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

/**
 * @param {{ argv?: string[], emitOnReady?: (hooks: { signal: EventEmitter, disconnect: () => void }) => void }} [options]
 */
async function run(options = {}) {
    const stdout = capture();
    const stderr = capture();
    const signal = new EventEmitter();
    let exitCode = /** @type {number | undefined} */ (undefined);
    let exits = 0;
    /** @type {(() => void) | null} */
    let disconnect = null;
    let seenDebug;
    harness.factory = (config) => {
        seenDebug = process.env.DEBUG;
        expect(Object.keys(config)).toEqual(['onDisconnected']);
        disconnect = config.onDisconnected;
        return {
            async start() {},
            async stop() {},
        };
    };
    const result = await runAgentWorker({
        argv: options.argv ?? [],
        stdout: stdout.stream,
        stderr: stderr.stream,
        signalSource: signal,
        exit(code) {
            exits += 1;
            exitCode = code;
        },
    });
    return { stdout: stdout.read(), stderr: stderr.read(), signal, result, exitCode, exits, seenDebug, disconnect };
}

afterEach(() => {
    restoreEnv();
});

describe('agent-worker', () => {
    it('does not import the legacy browser surfaces or start on import', () => {
        expect(createdAtImport).toBe(0);
        expect(workerSource).not.toMatch(/['"]\.\/browser\.mjs['"]|['"]\.\.\/\.\.\/web-ai\/cli\.mjs['"]|web-ai\/mcp-server\.mjs|adaptive-fetch|tab-manager|connectOverCDP|createServer/);
        expect(workerSource).not.toMatch(/launchPersistentContext|BROWSER_AGENT_HOME|CDP_PORT/);
    });

    it('starts and stops once when the signal is repeated', async () => {
        const stdout = capture();
        const stderr = capture();
        const signal = new EventEmitter();
        let stops = 0;
        let starts = 0;
        harness.factory = () => ({
            async start() { starts += 1; },
            async stop() { stops += 1; },
        });
        const result = await runAgentWorker({
            argv: [],
            stdout: {
                write(chunk) {
                    stdout.stream.write(chunk);
                    if (String(chunk).includes('ready')) {
                        signal.emit('SIGTERM');
                        signal.emit('SIGINT');
                        signal.emit('SIGTERM');
                    }
                    return true;
                },
            },
            stderr: stderr.stream,
            signalSource: signal,
            exit() {},
        });
        expect(result).toBe(0);
        expect(starts).toBe(1);
        expect(stops).toBe(1);
        expect(stdout.read()).toBe('agbrowse-agent: ready\nagbrowse-agent: stopped\n');
        expect(stderr.read()).toBe('');
    });

    it('cleans up and exits nonzero when startup fails', async () => {
        let stops = 0;
        harness.factory = () => ({
            async start() {
                throw Object.assign(new Error('profile lock busy'), { code: 'LOCK_HELD' });
            },
            async stop() { stops += 1; },
        });
        const stdout = capture();
        const stderr = capture();
        const code = await runAgentWorker({
            argv: [],
            stdout: stdout.stream,
            stderr: stderr.stream,
            signalSource: new EventEmitter(),
            exit() {},
        });
        expect(code).toBe(1);
        expect(stops).toBe(1);
        expect(stdout.read()).toBe('');
        expect(stderr.read()).toBe('agbrowse-agent: error code=LOCK_HELD\n');
    });

    it('exits on disconnect without relaunching', async () => {
        const stdout = capture();
        const stderr = capture();
        const signal = new EventEmitter();
        let starts = 0;
        let stops = 0;
        /** @type {(() => void) | undefined} */
        let disconnect;
        harness.factory = (config) => {
            disconnect = config.onDisconnected;
            return {
                async start() { starts += 1; },
                async stop() { stops += 1; },
            };
        };
        const pending = runAgentWorker({
            argv: [],
            stdout: {
                write(chunk) {
                    stdout.stream.write(chunk);
                    if (String(chunk).includes('ready')) disconnect?.();
                    return true;
                },
            },
            stderr: stderr.stream,
            signalSource: signal,
            exit() {},
        });
        const code = await pending;
        expect(code).toBe(1);
        expect(starts).toBe(1);
        expect(stops).toBe(1);
        expect(stdout.read()).toBe('agbrowse-agent: ready\n');
        expect(stderr.read()).toBe('agbrowse-agent: error code=BROWSER_DISCONNECTED\n');
    });

    it('omits injected secrets from startup failure output', async () => {
        process.env.DEBUG = 'pw:api SECRET_DEBUG_TOKEN';
        process.env.PWDEBUG = '1';
        process.env.BROWSER_AGENT_HOME = 'legacy-secret-home';
        let stops = 0;
        let debugAtCreate;
        harness.factory = () => {
            debugAtCreate = process.env.DEBUG;
            return {
                async start() {
                    const error = new Error([
                        'Playwright launch failed',
                        'super-secret-cookie-value',
                        'https://evil.example/private?token=sekret',
                        '--user-data-dir=/tmp/secret-profile',
                        '--remote-debugging-port=9222',
                        process.env.BROWSER_AGENT_HOME,
                        process.env.DEBUG,
                    ].join(' '));
                    error.stack = `${error.message}\n    at launch (/tmp/secret-profile/playwright.js:1:1)`;
                    throw error;
                },
                async stop() { stops += 1; },
            };
        };
        const stdout = capture();
        const stderr = capture();
        const code = await runAgentWorker({
            argv: [],
            stdout: stdout.stream,
            stderr: stderr.stream,
            signalSource: new EventEmitter(),
            exit() {},
        });
        const combined = `${stdout.read()}\n${stderr.read()}`;
        expect(code).toBe(1);
        expect(stops).toBe(1);
        expect(debugAtCreate).toBeUndefined();
        expect(stderr.read()).toBe('agbrowse-agent: error code=STARTUP_FAILED\n');
        expect(stdout.read()).toBe('');
        for (const secret of SECRETS) expect(combined).not.toContain(secret);
        expect(combined).not.toMatch(/Playwright|evil\.example|cookie|user-data-dir/i);
        expect(process.env.DEBUG).toBe('pw:api SECRET_DEBUG_TOKEN');
    });

    it('rejects profile, endpoint, and port arguments before launch', async () => {
        const cases = [
            ['--profile', '/tmp/legacy-secret-home'],
            ['--endpoint', 'http://127.0.0.1:9222'],
            ['--port', '9222'],
            ['--user-data-dir', '/tmp/secret-profile'],
            ['http://127.0.0.1:9222'],
            ['--help', '--port', '9222'],
        ];
        for (const argv of cases) {
            const created = harness.created;
            const stdout = capture();
            const stderr = capture();
            const code = await runAgentWorker({
                argv,
                stdout: stdout.stream,
                stderr: stderr.stream,
                signalSource: new EventEmitter(),
                exit() {},
            });
            expect(code).toBe(1);
            expect(harness.created).toBe(created);
            expect(stdout.read()).toBe('');
            expect(stderr.read()).toBe('agbrowse-agent: error code=INVALID_ARGUMENTS\n');
        }
    });

    it('prints help without starting the runtime', async () => {
        const before = harness.created;
        const helped = await run({ argv: ['--help'] });
        expect(helped.result).toBe(0);
        expect(helped.exitCode).toBe(0);
        expect(harness.created).toBe(before);
        expect(helped.stderr).toBe('');
        expect(helped.stdout).toContain('node skills/browser/agent-worker.mjs');
        expect(helped.stdout).toContain('~/.agbrowse-bpdus/agent-profile');
        expect(helped.stdout).not.toMatch(/9222|cookie|SECRET/);
    });

    it('answers --help from a direct process without launching Chrome', () => {
        const result = spawnSync(process.execPath, [workerScript, '--help'], {
            cwd: repoRoot,
            encoding: 'utf8',
            timeout: 5000,
            env: { ...process.env, DEBUG: 'pw:api SECRET_DEBUG_TOKEN', PWDEBUG: '1' },
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('~/.agbrowse-bpdus/agent-profile');
        expect(`${result.stdout}\n${result.stderr}`).not.toContain('SECRET_DEBUG_TOKEN');
        const rejected = spawnSync(process.execPath, [workerScript, '--port', '9222'], {
            cwd: repoRoot,
            encoding: 'utf8',
            timeout: 5000,
            env: { ...process.env, DEBUG: 'pw:api SECRET_DEBUG_TOKEN' },
        });
        expect(rejected.status).toBe(1);
        expect(rejected.stderr).toBe('agbrowse-agent: error code=INVALID_ARGUMENTS\n');
        expect(`${rejected.stdout}\n${rejected.stderr}`).not.toContain('SECRET_DEBUG_TOKEN');
    });
});
