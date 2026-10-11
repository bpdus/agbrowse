// @ts-check
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectReadEndpoint } from '../../skills/browser/agent-ipc.mjs';
import { READ_ERROR_MESSAGES, readError } from '../../skills/browser/agent-read-error.mjs';

/** @param {string[]} argv */
function parseArgs(argv) {
    let outputPath = null;
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] !== '--out' || outputPath !== null) throw readError('INVALID_ARGUMENTS');
        const value = argv[index + 1];
        if (!value || value.startsWith('--')) throw readError('INVALID_ARGUMENTS');
        outputPath = value;
        index += 1;
    }
    if (!outputPath) throw readError('INVALID_ARGUMENTS');
    return outputPath;
}

/**
 * @param {{ argv?: string[], stdout?: import('node:stream').Writable, stderr?: import('node:stream').Writable, connect?: typeof connectReadEndpoint, fs?: typeof fs }} [options]
 */
export async function runNaverTopbarCapture(options = {}) {
    const stdout = options.stdout ?? process.stdout;
    const stderr = options.stderr ?? process.stderr;
    const io = options.fs ?? fs;
    /** @type {ReturnType<typeof connectReadEndpoint> | null} */
    let client = null;
    try {
        const outputPath = path.resolve(parseArgs(options.argv ?? process.argv.slice(2)));
        client = (options.connect ?? connectReadEndpoint)();
        const result = await client.call('operator.naver.topbar_structure', {});
        if (typeof result !== 'string') throw readError('INTERNAL');
        const bytes = Buffer.from(result, 'utf8');
        let existing = null;
        try {
            existing = io.lstatSync(outputPath);
        } catch (error) {
            if (/** @type {{ code?: string }} */ (error).code !== 'ENOENT') throw readError('STATE_UNSAFE');
        }
        if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.uid !== process.getuid())) {
            throw readError('STATE_UNSAFE');
        }
        const flags = io.constants.O_WRONLY | io.constants.O_CREAT | io.constants.O_NOFOLLOW
            | (existing ? 0 : io.constants.O_EXCL);
        const fd = io.openSync(outputPath, flags, 0o600);
        try {
            const opened = io.fstatSync(fd);
            if (!opened.isFile() || opened.uid !== process.getuid()
                || (existing && (opened.dev !== existing.dev || opened.ino !== existing.ino))) {
                throw readError('STATE_UNSAFE');
            }
            io.fchmodSync(fd, 0o600);
            io.ftruncateSync(fd, 0);
            io.writeFileSync(fd, bytes);
            io.fsyncSync(fd);
            if ((io.fstatSync(fd).mode & 0o777) !== 0o600) throw readError('STATE_UNSAFE');
        } finally {
            io.closeSync(fd);
        }
        stdout.write(`${bytes.length}\n`);
        return 0;
    } catch (error) {
        const candidate = error && /** @type {{ code?: string }} */ (error).code;
        const code = typeof candidate === 'string' && Object.hasOwn(READ_ERROR_MESSAGES, candidate)
            ? candidate
            : 'STATE_UNSAFE';
        stderr.write(`agbrowse-capture-naver-topbar: error code=${code}\n`);
        return 1;
    } finally {
        try { client?.close(); } catch { /* already closed */ }
    }
}

function isInvokedDirectly() {
    const entry = process.argv[1];
    return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

if (isInvokedDirectly()) {
    runNaverTopbarCapture().then((status) => {
        process.exitCode = status;
    }).catch(() => {
        process.stderr.write('agbrowse-capture-naver-topbar: error code=INTERNAL\n');
        process.exitCode = 1;
    });
}
