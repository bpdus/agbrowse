// @ts-check
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { spawn as nodeSpawn } from 'node:child_process';
import { readError } from './agent-read-error.mjs';

const SERVICE = 'agbrowse.naver';
const SECURITY = '/usr/bin/security';

export function encodeSecurityArgument(value) {
    if (typeof value !== 'string' || /[\0\r\n]/.test(value)) throw readError('INVALID_ARGUMENTS');
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function safeDirectory(home) {
    const root = path.join(home, '.agbrowse-bpdus');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || rootStat.uid !== process.getuid()) throw readError('STATE_UNSAFE');
    if ((rootStat.mode & 0o777) !== 0o700) fs.chmodSync(root, 0o700);
    const directory = path.join(root, 'state');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== process.getuid()) throw readError('STATE_UNSAFE');
    if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(directory, 0o700);
    return directory;
}

function secureAccountPath(home) {
    return path.join(safeDirectory(home), 'naver-account');
}

function writeAccount(home, account) {
    const file = secureAccountPath(home);
    try {
        const old = fs.lstatSync(file);
        if (old.isSymbolicLink() || !old.isFile() || old.uid !== process.getuid()) throw readError('STATE_UNSAFE');
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try { fs.writeFileSync(fd, account, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    fs.chmodSync(file, 0o600);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw readError('STATE_UNSAFE');
}

function runSecurity(args, options = {}) {
    const spawn = options.spawn ?? nodeSpawn;
    const timeoutMs = options.timeoutMs ?? 5000;
    return new Promise((resolve) => {
        let child;
        let stdout = '';
        let settled = false;
        const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
        try {
            child = spawn(SECURITY, args, { shell: false, stdio: ['pipe', options.capture ? 'pipe' : 'ignore', 'ignore'], windowsHide: true });
        } catch { finish({ ok: false }); return; }
        child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); if (stdout.length > 8192) { child.kill(); finish({ ok: false }); } });
        child.on('error', () => finish({ ok: false }));
        child.on('close', (code) => finish({ ok: code === 0, stdout }));
        const timer = setTimeout(() => { child.kill(); finish({ ok: false }); }, timeoutMs);
        if (options.input !== undefined) { child.stdin?.end(options.input); }
        else child.stdin?.end();
    });
}

export function createNaverCredentialStore(options = {}) {
    const home = options.home ?? homedir();
    const keychain = options.keychainPath ?? path.join(home, 'Library/Keychains/login.keychain-db');
    const commandOptions = { spawn: options.spawn, timeoutMs: options.timeoutMs };
    return {
        async saveCredentials(account, password) {
            if (typeof account !== 'string' || !account.trim() || account.length > 256 || typeof password !== 'string' || !password || password.length > 1024) return { result: 'failed', reason: 'invalid_input' };
            let command;
            try { command = `add-generic-password -U -s ${SERVICE} -a ${encodeSecurityArgument(account)} -w ${encodeSecurityArgument(password)} ${encodeSecurityArgument(keychain)}\n`; }
            catch { return { result: 'failed', reason: 'invalid_input' }; }
            if (Buffer.byteLength(command) >= 4096) return { result: 'failed', reason: 'invalid_input' };
            const result = await runSecurity(['-i', '-q'], { ...commandOptions, input: command });
            if (!result.ok) return { result: 'failed', reason: 'keychain_write_failed' };
            try { writeAccount(home, account); } catch { return { result: 'failed', reason: 'state_write_failed' }; }
            return { result: 'saved' };
        },
        async readCredentials(account) {
            let selected = account;
            if (selected === undefined) {
                try {
                    const file = secureAccountPath(home); const stat = fs.lstatSync(file);
                    if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) return { result: 'failed', reason: 'state_unsafe' };
                    selected = fs.readFileSync(file, 'utf8');
                } catch { return { result: 'failed', reason: 'account_unavailable' }; }
            }
            if (typeof selected !== 'string' || !selected || /[\0\r\n]/.test(selected)) return { result: 'failed', reason: 'account_unavailable' };
            const result = await runSecurity(['find-generic-password', '-s', SERVICE, '-a', selected, '-w', keychain], { ...commandOptions, capture: true });
            if (!result.ok) return { result: 'failed', reason: 'keychain_read_failed' };
            return { result: 'credentials', account: selected, password: result.stdout.replace(/\n$/, '') };
        },
    };
}
