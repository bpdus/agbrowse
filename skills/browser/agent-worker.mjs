// @ts-check
/**
 * Foreground opt-in worker. Invoke with `node skills/browser/agent-worker.mjs`.
 * Prints fixed lifecycle lines only. No socket, MCP, or session database.
 */

import { pathToFileURL } from 'node:url';

const DEBUG_ENV_KEYS = ['DEBUG', 'PWDEBUG', 'DEBUG_FILE'];
const ALLOWED_ERROR_CODES = new Set([
    'INVALID_ARGUMENTS',
    'INVALID_CONFIG',
    'PROFILE_UNSAFE',
    'PROFILE_UNWRITABLE',
    'LOCK_HELD',
    'STARTUP_FAILED',
    'BROWSER_DISCONNECTED',
    'NOT_RUNNING',
    'SESSION_NOT_FOUND',
    'SESSION_CLOSED',
    'ALREADY_RUNNING',
    'SHUTDOWN_FAILED',
]);

const HELP = [
    'agbrowse agent worker',
    '',
    'Usage:',
    '  node skills/browser/agent-worker.mjs',
    '  node skills/browser/agent-worker.mjs --help',
    '',
    'Starts a foreground worker with the dedicated Chrome profile',
    '~/.agbrowse-bpdus/agent-profile and the debugging pipe.',
    'No profile, endpoint, or port arguments are accepted.',
    'Stop the worker with SIGINT or SIGTERM.',
    '',
].join('\n');

/**
 * @param {unknown} error
 * @returns {string}
 */
function publicErrorCode(error) {
    const code = error && /** @type {{ code?: string }} */ (error).code;
    if (code && ALLOWED_ERROR_CODES.has(code)) return code;
    return 'STARTUP_FAILED';
}

/**
 * @returns {Record<string, string | undefined>}
 */
function suppressInheritedDebug() {
    /** @type {Record<string, string | undefined>} */
    const saved = {};
    for (const key of DEBUG_ENV_KEYS) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
    return saved;
}

/**
 * @param {Record<string, string | undefined>} saved
 */
function restoreInheritedDebug(saved) {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

/**
 * @param {import('node:stream').Writable} stream
 * @param {string} code
 */
function writeError(stream, code) {
    stream.write(`agbrowse-agent: error code=${code}\n`);
}

/**
 * @typedef {Object} AgentWorkerOptions
 * @property {string[]} [argv]
 * @property {import('node:stream').Writable} [stdout]
 * @property {import('node:stream').Writable} [stderr]
 * @property {{ on: Function, off?: Function, removeListener?: Function }} [signalSource]
 * @property {(code: number) => void} [exit]
 */

/**
 * @param {AgentWorkerOptions} [options]
 * @returns {Promise<number>}
 */
export async function runAgentWorker(options = {}) {
    const argv = options.argv ?? process.argv.slice(2);
    const stdout = options.stdout ?? process.stdout;
    const stderr = options.stderr ?? process.stderr;
    const signalSource = options.signalSource ?? process;
    const exit = options.exit ?? ((code) => { process.exit(code); });

    /**
     * @param {number} code
     * @returns {number}
     */
    function finish(code) {
        exit(code);
        return code;
    }

    if (argv.length === 1 && argv[0] === '--help') {
        stdout.write(HELP);
        return finish(0);
    }
    if (argv.length > 0) {
        writeError(stderr, 'INVALID_ARGUMENTS');
        return finish(1);
    }

    const savedDebug = suppressInheritedDebug();
    /** @type {() => void} */
    let removeSignals = () => {};
    try {
        const { createAgentRuntime } = await import('./agent-runtime.mjs');
        /** @type {ReturnType<typeof createAgentRuntime> | null} */
        let runtime = null;
        let settled = false;
        /** @type {'signal' | 'disconnected' | null} */
        let reason = null;
        /** @type {(value: 'signal' | 'disconnected') => void} */
        let wake = () => {};
        const wait = new Promise((resolve) => {
            wake = (value) => {
                if (settled) return;
                settled = true;
                reason = value;
                resolve(value);
            };
        });

        // Own both signals before launch and until stop() finishes. Removing
        // them earlier lets a second signal hit Node's default termination.
        const onSignal = () => { wake('signal'); };
        signalSource.on('SIGINT', onSignal);
        signalSource.on('SIGTERM', onSignal);
        removeSignals = () => {
            if (typeof signalSource.off === 'function') {
                signalSource.off('SIGINT', onSignal);
                signalSource.off('SIGTERM', onSignal);
            } else if (typeof signalSource.removeListener === 'function') {
                signalSource.removeListener('SIGINT', onSignal);
                signalSource.removeListener('SIGTERM', onSignal);
            }
        };

        try {
            runtime = createAgentRuntime({
                onDisconnected() { wake('disconnected'); },
            });
            await runtime.start();
        } catch (error) {
            let reported = error;
            if (runtime) {
                try { await runtime.stop(); } catch (stopError) { reported = stopError; }
            }
            writeError(stderr, publicErrorCode(reported));
            return finish(1);
        }

        if (!settled) {
            stdout.write('agbrowse-agent: ready\n');
            await wait;
        }

        try {
            await runtime.stop();
        } catch (error) {
            writeError(stderr, publicErrorCode(error));
            return finish(1);
        }

        if (reason === 'disconnected') {
            writeError(stderr, 'BROWSER_DISCONNECTED');
            return finish(1);
        }
        stdout.write('agbrowse-agent: stopped\n');
        return finish(0);
    } catch {
        writeError(stderr, 'STARTUP_FAILED');
        return finish(1);
    } finally {
        removeSignals();
        restoreInheritedDebug(savedDebug);
    }
}

function isInvokedDirectly() {
    const entry = process.argv[1];
    if (!entry) return false;
    return import.meta.url === pathToFileURL(entry).href;
}

if (isInvokedDirectly()) {
    runAgentWorker().catch(() => {
        process.stderr.write('agbrowse-agent: error code=STARTUP_FAILED\n');
        process.exit(1);
    });
}
