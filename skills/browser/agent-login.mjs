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
    if (url.origin !== 'https://nid.naver.com' || url.username || url.password || url.search || url.hash || !LOGIN_PATHS.has(url.pathname) || isLogoutUrl(value)) {
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
            try { await (io.promises ?? io).lstat(path.join(profileDir, name)); present = true; }
            catch (error) { if (/** @type {{code?:string}} */ (error).code !== 'ENOENT') throw readError('PROFILE_RELEASE_TIMEOUT'); }
        }
        if (!present) return;
        if (Date.now() >= deadline) throw readError('PROFILE_RELEASE_TIMEOUT');
        await delay(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    } while (true);
}

const SAFE_KEYS = new Set(['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Backspace', 'Delete', 'Space']);

export function isPasswordTarget(info = {}) {
    return String(info.type ?? '').toLowerCase() === 'password'
        || /(?:^|\s)(?:current-password|new-password)(?:\s|$)/i.test(String(info.autocomplete ?? ''))
        || info.passwordIdentity === true;
}

/** One page controller. Ref identities live only as long as this document. */
export function createLoginController(page) {
    let refs = new Map();
    const protectedIdentity = new Set();
    let revision = 0;
    let snapshotSeq = 0;
    const disposeRefs = (items) => {
        for (const item of items.values()) void item.handle.dispose().catch(() => {});
    };
    const invalidate = () => { const old = refs; refs = new Map(); revision += 1; disposeRefs(old); };
    page.on?.('framenavigated', (frame) => { if (!page.mainFrame || frame === page.mainFrame()) invalidate(); });

    async function snapshotLoginPage() {
        const revisionAtStart = revision;
        const selector = 'a,button,input,select,textarea,[role="button"],[role="link"],[tabindex]';
        const handles = await page.$$(selector);
        const nodes = [];
        for (let index = 0; index < handles.length; index += 1) {
            const handle = handles[index];
            if (nodes.length >= 120) { await handle.dispose(); continue; }
            const node = await handle.evaluate((el) => {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                if (!(rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none')) return null;
                const e = /** @type {HTMLElement & HTMLInputElement} */ (el);
                const label = e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.innerText || e.getAttribute('title') || '';
                return { tag: e.tagName.toLowerCase(), type: e.getAttribute('type') || '', label: label.trim().slice(0, 200), name: e.getAttribute('name') || '', id: e.id || '', autocomplete: e.getAttribute('autocomplete') || '' };
            });
            if (node) nodes.push({ handle, node });
            else await handle.dispose();
        }
        if (revision !== revisionAtStart) {
            for (const { handle } of nodes) await handle.dispose().catch(() => {});
            throw readError('STATE_CHANGED');
        }
        const oldRefs = refs;
        refs = new Map();
        disposeRefs(oldRefs);
        snapshotSeq += 1;
        const controls = nodes.map(({ handle, node }, index) => {
            const ref = `s${snapshotSeq}_${index + 1}`;
            const identity = `${node.tag}|${node.name}|${node.id}|${node.autocomplete}`;
            const isPassword = node.type === 'password' || /(?:current-password|new-password)/i.test(node.autocomplete) || protectedIdentity.has(identity);
            if (isPassword) protectedIdentity.add(identity);
            refs.set(ref, { handle, identity, passwordIdentity: isPassword, revision });
            return { ref, role: node.tag === 'input' ? 'input' : node.tag, label: node.label, type: isPassword ? 'password' : node.type, redacted: isPassword };
        });
        return { url: new URL(page.url()).origin, controls };
    }

    function resolveLoginRef(ref) {
        const match = /^s(\d+)_\d+$/.exec(ref);
        if (!match || Number(match[1]) !== snapshotSeq) throw readError('REF_STALE');
        const item = refs.get(ref);
        if (!item || item.revision !== revision) throw readError('REF_STALE');
        return item;
    }

    async function handleFor(item) {
        const connected = await item.handle.evaluate((el) => el.isConnected).catch(() => false);
        if (!connected) throw readError('REF_STALE');
        const info = await item.handle.evaluate((el) => ({ type: el.getAttribute('type') || '', autocomplete: el.getAttribute('autocomplete') || '', name: el.getAttribute('name') || '', id: el.id || '', tag: el.tagName.toLowerCase() })).catch(() => null);
        if (!info || `${info.tag}|${info.name}|${info.id}|${info.autocomplete}` !== item.identity) throw readError('REF_STALE');
        if (isPasswordTarget({ ...info, passwordIdentity: item.passwordIdentity || protectedIdentity.has(item.identity) })) throw readError('PASSWORD_REFUSED');
        return item.handle;
    }

    return {
        snapshot: snapshotLoginPage,
        async click(input) {
            if (typeof input?.ref === 'string') await (await handleFor(resolveLoginRef(input.ref))).click();
            else if (Number.isFinite(input?.x) && Number.isFinite(input?.y)) {
                const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
                if (input.x < 0 || input.y < 0 || input.x >= size.width || input.y >= size.height) throw readError('INVALID_ARGUMENTS');
                await page.mouse.click(input.x, input.y);
            }
            else throw readError('INVALID_ARGUMENTS');
            invalidate();
            return { clicked: true };
        },
        async typeLoginText(input) {
            if (typeof input.text !== 'string' || input.text.length > 1000) throw readError('INVALID_ARGUMENTS');
            if (typeof input.ref === 'string') await (await handleFor(resolveLoginRef(input.ref))).fill(input.text);
            else {
                const focused = page.locator(':focus');
                const info = await focused.evaluate((el) => ({ type: el.getAttribute('type') || '', autocomplete: el.getAttribute('autocomplete') || '', name: el.getAttribute('name') || '', id: el.id || '' })).catch(() => null);
                if (!info) throw readError('ACTION_DENIED');
                const identity = `${String(await focused.evaluate((el) => el.tagName).catch(() => '')).toLowerCase()}|${info.name}|${info.id}|${info.autocomplete}`;
                if (isPasswordTarget({ ...info, passwordIdentity: protectedIdentity.has(identity) })) throw readError('PASSWORD_REFUSED');
                await focused.fill(input.text);
            }
            invalidate();
            return { typed: true };
        },
        async pressLoginKey(key) {
            if (typeof key !== 'string' || !SAFE_KEYS.has(key) || /^[A-Za-z0-9]$/.test(key) || key === 'Enter' && false) throw readError('ACTION_DENIED');
            const focused = page.locator(':focus');
            const info = await focused.evaluate((el) => ({ type: el.getAttribute('type') || '', autocomplete: el.getAttribute('autocomplete') || '', name: el.getAttribute('name') || '', id: el.id || '' })).catch(() => null);
            if (info) {
                const identity = `${String(await focused.evaluate((el) => el.tagName).catch(() => '')).toLowerCase()}|${info.name}|${info.id}|${info.autocomplete}`;
                if (isPasswordTarget({ ...info, passwordIdentity: protectedIdentity.has(identity) })) throw readError('PASSWORD_REFUSED');
            }
            await page.keyboard.press(key);
            invalidate();
            return { pressed: true };
        },
        clear: invalidate,
    };
}
