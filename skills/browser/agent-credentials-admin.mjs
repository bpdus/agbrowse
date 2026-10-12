// @ts-check
import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { readError } from './agent-read-error.mjs';

const TTL_MS = 15 * 60 * 1000;
const TOKEN_FILE = 'credentials-token';

function tokenPath(home) {
    const root = path.join(home, '.agbrowse-bpdus');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    let st = fs.lstatSync(root);
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid()) throw readError('STATE_UNSAFE');
    fs.chmodSync(root, 0o700);
    const state = path.join(root, 'state');
    fs.mkdirSync(state, { recursive: true, mode: 0o700 });
    st = fs.lstatSync(state);
    if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid()) throw readError('STATE_UNSAFE');
    fs.chmodSync(state, 0o700);
    return path.join(state, TOKEN_FILE);
}

export function issueCredentialsToken(options = {}) {
    const home = options.home ?? homedir();
    const file = tokenPath(home);
    const token = randomBytes(32).toString('hex');
    const record = JSON.stringify({ token, expiresAt: Date.now() + TTL_MS });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, record, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
    return { token, expiresAt: Date.now() + TTL_MS };
}

let consumeChain = Promise.resolve();
export function consumeCredentialsToken(candidate, options = {}) {
    const run = consumeChain.then(() => {
        const file = tokenPath(options.home ?? homedir());
        let st;
        try { st = fs.lstatSync(file); } catch { return false; }
        if (st.isSymbolicLink() || !st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) return false;
        const claim = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.used`;
        try { fs.renameSync(file, claim); } catch { return false; }
        let record;
        try { record = JSON.parse(fs.readFileSync(claim, 'utf8')); } catch { fs.rmSync(claim, { force: true }); return false; }
        fs.rmSync(claim, { force: true });
        const expected = Buffer.from(typeof record.token === 'string' ? record.token : '', 'utf8');
        const actual = Buffer.from(typeof candidate === 'string' ? candidate : '', 'utf8');
        const same = expected.length === 64 && actual.length === expected.length && timingSafeEqual(expected, actual);
        return same && Number.isFinite(record.expiresAt) && record.expiresAt > (options.now ?? Date.now());
    });
    consumeChain = run.then(() => undefined, () => undefined);
    return run;
}

export async function handleCredentialsRequest(input, options = {}) {
    const { token, account, password } = input ?? {};
    if (typeof token !== 'string' || typeof account !== 'string' || typeof password !== 'string') return { result: 'failed', reason: 'invalid_input' };
    const consume = options.consume ?? ((value) => consumeCredentialsToken(value, options));
    if (!await consume(token)) return { result: 'failed', reason: 'token_invalid' };
    return options.save ? options.save(account, password) : { result: 'failed', reason: 'unavailable' };
}

async function main() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('console required');
    const result = issueCredentialsToken();
    process.stdout.write(`${result.token}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try { await main(); } catch { process.stderr.write('credentials-token: failed\n'); process.exitCode = 1; }
}
