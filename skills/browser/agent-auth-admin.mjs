// @ts-check
import { pathToFileURL } from 'node:url';
import { createAuthService } from './agent-auth.mjs';
import { createDevFileKeyStore, createJsonStateStore } from './agent-auth-store.mjs';
import { readError } from './agent-read-error.mjs';

export async function runAuthAdminCli(options = {}) {
    const argv = options.argv ?? process.argv.slice(2);
    const stderr = options.stderr ?? process.stderr;
    const stdout = options.stdout ?? process.stdout;
    let stateStore; let keyStore; let auth;
    try {
        const args = {};
        for (let i = 0; i < argv.length; i += 1) {
            if (!['--state-dir', '--key-dir', '--device-id'].includes(argv[i]) || !argv[i + 1]) throw readError('INVALID_ARGUMENTS');
            args[argv[i].slice(2)] = argv[++i];
        }
        if (!args['state-dir'] || !args['key-dir'] || !args['device-id'] || argv.length !== 6) throw readError('INVALID_ARGUMENTS');
        stateStore = createJsonStateStore({ directory: args['state-dir'] });
        const identity = stateStore.load();
        if (!identity) throw readError('STATE_UNSAFE');
        keyStore = createDevFileKeyStore({ directory: args['key-dir'] });
        auth = createAuthService({ stateStore, keyStore, gatewayId: identity.gateway_id, audience: identity.audience, resource: identity.resource });
        const result = await auth.grantDeviceScope(args['device-id'], 'login:operate');
        stdout.write(`Granted login:operate to ${result.device_id} (epoch ${result.epoch}).\n`);
        return 0;
    } catch (error) {
        const code = error && typeof error.code === 'string' ? error.code : 'STATE_UNSAFE';
        stderr.write(`grant-login-scope: error code=${code}\n`);
        return 1;
    } finally {
        try { auth?.close(); } catch {}
        try { stateStore?.close(); } catch {}
        try { keyStore?.close(); } catch {}
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runAuthAdminCli();
