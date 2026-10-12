// @ts-check
import { pathToFileURL } from 'node:url';
import { connectReadEndpoint } from './agent-ipc.mjs';
import { readError } from './agent-read-error.mjs';

export async function runLoginModeCli(options = {}) {
    const argv = options.argv ?? process.argv.slice(2);
    const stdout = options.stdout ?? process.stdout;
    const stderr = options.stderr ?? process.stderr;
    let client = options.client ?? null;
    try {
        if (argv.length !== 1 || !['start', 'end', 'status'].includes(argv[0])) throw readError('INVALID_ARGUMENTS');
        const operation = { start: 'login.start', end: 'login.end', status: 'login.status' }[argv[0]];
        client ??= connectReadEndpoint();
        const result = await client.call(operation, {});
        if (!result || !['normal','login','transitioning'].includes(result.mode) || typeof result.ready !== 'boolean') throw readError('INTERNAL');
        stdout.write(`mode=${result.mode} ready=${result.ready ? 'yes' : 'no'}\n`);
        return result.ready ? 0 : 1;
    } catch (error) {
        const code = error && typeof error.code === 'string' ? error.code : 'INTERNAL';
        stderr.write(`login-mode: error code=${code}\n`);
        return 1;
    } finally {
        if (client && !options.client) client.close();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runLoginModeCli();
