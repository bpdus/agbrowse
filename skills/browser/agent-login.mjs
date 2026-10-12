// @ts-check
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readError } from './agent-read-error.mjs';

const LOGIN_PATHS = new Set(['/nidlogin.login']);
const CHROME_LOCKS = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

export function isLogoutUrl(value) {
    try {
        const url = new URL(value);
        return url.hostname.toLowerCase() === 'nid.naver.com' && url.pathname === '/nidlogin.logout';
    } catch { return false; }
}

export function classifyLoginRequest(value, method = 'GET') {
    let url;
    try { url = new URL(value); } catch { return 'deny'; }
    if (isLogoutUrl(url.href) || url.protocol !== 'https:' || (url.port && url.port !== '443')) return 'deny';
    const verb = method.toUpperCase();
    const host = url.hostname.toLowerCase();
    if (host === 'nid.naver.com') {
        if (LOGIN_PATHS.has(url.pathname) && ['GET', 'HEAD', 'POST'].includes(verb)) return 'allow';
        if (/^\/(?:login|nidlogin|captcha|static)(?:\/|\.|$)/i.test(url.pathname) && ['GET', 'HEAD'].includes(verb)) return 'allow';
        return 'deny';
    }
    if ((host.endsWith('.pstatic.net') && host.length > '.pstatic.net'.length
        || host === 'ncpt.naver.com') && ['GET', 'HEAD'].includes(verb)) return 'allow';
    return 'deny';
}

export function assertLoginNavigation(value) {
    let url;
    try { url = new URL(value); } catch { throw readError('DOMAIN_DENIED'); }
    if (url.origin !== 'https://nid.naver.com' || !LOGIN_PATHS.has(url.pathname) || isLogoutUrl(value)) {
        throw readError('DOMAIN_DENIED');
    }
    return url.href;
}

/** Wait until Chrome releases all singleton entries. Never removes them. */
export async function waitForProfileRelease(profileDir, options = {}) {
    const timeoutMs = options.timeoutMs ?? 30000;
    const intervalMs = options.intervalMs ?? 100;
    const io = options.fs ?? fs;
    const deadline = Date.now() + timeoutMs;
    do {
        let present = false;
        for (const name of CHROME_LOCKS) {
            try { io.lstatSync(path.join(profileDir, name)); present = true; }
            catch (error) { if (/** @type {{code?:string}} */ (error).code !== 'ENOENT') throw readError('PROFILE_RELEASE_TIMEOUT'); }
        }
        if (!present) return;
        if (Date.now() >= deadline) throw readError('PROFILE_RELEASE_TIMEOUT');
        await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    } while (true);
}

