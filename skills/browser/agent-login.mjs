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
    const invalidate = () => { refs = new Map(); revision += 1; };
    page.on?.('framenavigated', (frame) => { if (!page.mainFrame || frame === page.mainFrame()) invalidate(); });

    async function snapshotLoginPage() {
        const revisionAtStart = revision;
        const nodes = await page.evaluate(() => {
            const visible = (el) => {
                const rect = el.getBoundingClientRect();
                const style = getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            };
            const selector = 'a,button,input,select,textarea,[role="button"],[role="link"],[tabindex]';
            return Array.from(document.querySelectorAll(selector)).filter(visible).slice(0, 120).map((el) => {
                const e = /** @type {HTMLElement & HTMLInputElement} */ (el);
                const label = e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.innerText || e.getAttribute('title') || '';
                return { tag: e.tagName.toLowerCase(), type: e.getAttribute('type') || '', label: label.trim().slice(0, 200), name: e.getAttribute('name') || '', id: e.id || '', autocomplete: e.getAttribute('autocomplete') || '' };
            });
        });
        if (revision !== revisionAtStart) throw readError('STATE_CHANGED');
        refs = new Map();
        const controls = nodes.map((node, index) => {
            const ref = `lr_${index + 1}`;
            const identity = `${node.tag}|${node.name}|${node.id}|${node.autocomplete}`;
            const isPassword = node.type === 'password' || /(?:current-password|new-password)/i.test(node.autocomplete) || protectedIdentity.has(identity);
            if (isPassword) protectedIdentity.add(identity);
            refs.set(ref, { index, identity, passwordIdentity: isPassword, revision });
            return { ref, role: node.tag === 'input' ? 'input' : node.tag, label: node.label, type: isPassword ? 'password' : node.type, redacted: isPassword };
        });
        return { url: new URL(page.url()).origin, controls };
    }

    function resolveLoginRef(ref) {
        const item = refs.get(ref);
        if (!item || item.revision !== revision) throw readError('STALE_REF');
        return item;
    }

    async function locatorFor(item) {
        const locator = page.locator('a,button,input,select,textarea,[role="button"],[role="link"],[tabindex]').nth(item.index);
        const info = await locator.evaluate((el) => ({ type: el.getAttribute('type') || '', autocomplete: el.getAttribute('autocomplete') || '', name: el.getAttribute('name') || '', id: el.id || '' }));
        const identity = `${String((await locator.evaluate((el) => el.tagName)).toLowerCase())}|${info.name}|${info.id}|${info.autocomplete}`;
        if (isPasswordTarget({ ...info, passwordIdentity: item.passwordIdentity || protectedIdentity.has(identity) })) throw readError('PASSWORD_REFUSED');
        return locator;
    }

    return {
        snapshot: snapshotLoginPage,
        async click(input) {
            if (typeof input?.ref === 'string') await (await locatorFor(resolveLoginRef(input.ref))).click();
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
            if (typeof input.ref === 'string') await (await locatorFor(resolveLoginRef(input.ref))).fill(input.text);
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
