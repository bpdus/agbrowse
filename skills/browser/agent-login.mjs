// @ts-check
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
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

export function classifyLoginProgress(doc) {
    const root = doc ?? globalThis.document;
    if (!root?.querySelectorAll) return 'unknown';
    const visible = (element) => {
        const style = element.ownerDocument?.defaultView?.getComputedStyle?.(element);
        const rect = element.getBoundingClientRect?.();
        return (!style || style.visibility !== 'hidden' && style.display !== 'none') && (!rect || rect.width > 0 && rect.height > 0);
    };
    if ([...root.querySelectorAll('img[src], iframe[src], input, [role="img"]')].some((el) => visible(el) && /captcha|ncpt/i.test(`${el.id || ''} ${typeof el.className === 'string' ? el.className : ''} ${el.getAttribute?.('src') || ''}`))
        || [...root.querySelectorAll('form, h1, h2, p, div, span, strong')].some((el) => visible(el) && /보안문자|자동입력 방지|captcha/i.test(el.textContent || ''))) return 'needs_human';
    if ([...root.querySelectorAll('form, h1, h2, p, div, span, strong, button')].some((el) => visible(el) && /새 기기|새로운 기기|2단계 인증|휴대폰 승인|로그인 승인|본인 확인/i.test(el.textContent || '') && /승인|확인|인증/.test(el.textContent || ''))) return 'needs_phone_approval';
    if ([...root.querySelectorAll('a[href], [data-href], [formaction]')].some((el) => {
        for (const attr of ['href', 'data-href', 'formaction']) { const val = el.getAttribute(attr); if (!val) continue; try { const url = new URL(val, 'https://nid.naver.com'); if (url.host === 'nid.naver.com' && url.pathname === '/nidlogin.logout') return true; } catch {} }
        return false;
    })) return 'logged_in';
    const id = [...root.querySelectorAll('input#id[name="id"]')].filter(visible);
    const pw = [...root.querySelectorAll('input#pw[name="pw"]')].filter(visible);
    if (id.length === 1 && pw.length === 1) return 'login_page';
    return 'unknown';
}

/** One page controller. Ref identities live only as long as this document. */
export function createLoginController(page) {
    const nonce = randomBytes(8).toString('hex');
    let refs = new Map();
    const protectedIdentity = new Set();
    let revision = 0;
    let snapshotSeq = 0;
    let credentialsFilled = false;
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
            const ref = `${nonce}_s${snapshotSeq}_${index + 1}`;
            const identity = `${node.tag}|${node.name}|${node.id}|${node.autocomplete}`;
            const isPassword = node.type === 'password' || /(?:current-password|new-password)/i.test(node.autocomplete) || protectedIdentity.has(identity);
            if (isPassword) protectedIdentity.add(identity);
            refs.set(ref, { handle, identity, passwordIdentity: isPassword, revision });
            return { ref, role: node.tag === 'input' ? 'input' : node.tag, label: isPassword ? '' : node.label, type: isPassword ? 'password' : node.type, redacted: isPassword };
        });
        return { url: new URL(page.url()).origin, controls };
    }

    function resolveLoginRef(ref) {
        const match = /^([a-f0-9]{16})_s(\d+)_(\d+)$/.exec(ref);
        if (!match || match[1] !== nonce || Number(match[2]) !== snapshotSeq) throw readError('REF_STALE');
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
            if (input && Object.hasOwn(input, 'ref')) {
                if (typeof input.ref !== 'string') throw readError('REF_STALE');
                const item = resolveLoginRef(input.ref);
                if (credentialsFilled && await item.handle.evaluate((el) => Boolean(el.closest('form')?.querySelector('#id[name="id"],#pw[name="pw"]')))) throw readError('ACTION_DENIED');
                await (await handleFor(item)).click();
            }
            else if (Number.isFinite(input?.x) && Number.isFinite(input?.y)) {
                const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
                if (input.x < 0 || input.y < 0 || input.x >= size.width || input.y >= size.height) throw readError('INVALID_ARGUMENTS');
                if (credentialsFilled && await page.evaluate(({x,y}) => { const el = document.elementFromPoint(x,y); return Boolean(el?.closest('form')?.querySelector('#id[name="id"],#pw[name="pw"]')); }, input)) throw readError('ACTION_DENIED');
                await page.mouse.click(input.x, input.y);
            }
            else throw readError('INVALID_ARGUMENTS');
            invalidate();
            return { clicked: true };
        },
        async typeLoginText(input) {
            if (typeof input.text !== 'string' || input.text.length > 1000) throw readError('INVALID_ARGUMENTS');
            if (Object.hasOwn(input, 'ref')) {
                if (typeof input.ref !== 'string') throw readError('REF_STALE');
                await (await handleFor(resolveLoginRef(input.ref))).fill(input.text);
            }
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
            if (credentialsFilled && key === 'Enter') throw readError('ACTION_DENIED');
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
        async fillCredentials(readCredentials) {
            try {
                if (new URL(page.url()).origin !== 'https://nid.naver.com' || new URL(page.url()).pathname !== '/nidlogin.login') return { result: 'failed', reason: 'wrong_page' };
                const ids = page.locator('input#id[name="id"]'); const passwords = page.locator('input#pw[name="pw"]');
                if (await ids.count() !== 1 || await passwords.count() !== 1 || !await ids.isVisible() || !await passwords.isVisible()) return { result: 'failed', reason: 'fields_unavailable' };
                const valid = await Promise.all([ids, passwords].map((locator) => locator.evaluate((el) => {
                    const form = el.form; const action = form?.getAttribute('action') || '/nidlogin.login';
                    let url; try { url = new URL(action, location.href); } catch { return false; }
                    return el instanceof el.ownerDocument.defaultView.HTMLInputElement && url.origin === 'https://nid.naver.com' && url.pathname === '/nidlogin.login';
                })));
                if (!valid.every(Boolean)) return { result: 'failed', reason: 'fields_untrusted' };
                if (!await ids.evaluate((el) => el.form === document.querySelector('input#pw[name="pw"]')?.form)) return { result: 'failed', reason: 'fields_untrusted' };
                const values = await readCredentials();
                if (values?.result !== 'credentials') {
                    const reasons = new Set(['invalid_input','account_unavailable','keychain_read_failed','state_unsafe']);
                    return { result: 'failed', reason: reasons.has(values?.reason) ? values.reason : 'credentials_unavailable' };
                }
                protectedIdentity.add('input|pw|pw|'); credentialsFilled = true;
                await ids.fill(values.account); await passwords.fill(values.password);
                invalidate();
                return { result: 'filled', reason: 'none' };
            } catch { return { result: 'failed', reason: 'fill_failed' }; }
        },
        async submit() {
            try {
                if (!credentialsFilled || new URL(page.url()).origin !== 'https://nid.naver.com' || new URL(page.url()).pathname !== '/nidlogin.login') return { result: 'failed', reason: 'not_filled' };
                const button = page.locator('#log.login');
                if (await button.count() !== 1 || !await button.isVisible()) return { result: 'failed', reason: 'button_unavailable' };
                const valid = await button.evaluate((el) => el instanceof el.ownerDocument.defaultView.HTMLButtonElement || el instanceof el.ownerDocument.defaultView.HTMLInputElement ? el.form?.querySelector('input#id[name="id"]') && el.form?.querySelector('input#pw[name="pw"]') : Boolean(el.closest('form')?.querySelector('input#id[name="id"]') && el.closest('form')?.querySelector('input#pw[name="pw"]')));
                if (!valid) return { result: 'failed', reason: 'button_untrusted' };
                await button.click(); credentialsFilled = false; invalidate(); return { result: 'submitted', reason: 'none' };
            } catch { return { result: 'failed', reason: 'submit_failed' }; }
        },
        async checkProgress() {
            try { return { status: await page.evaluate(classifyLoginProgress) }; } catch { return { status: 'unknown' }; }
        },
        async screenshot() {
            try { return await page.screenshot({ type: 'png', mask: [page.locator('input#pw[name="pw"]')] }); }
            catch { if (credentialsFilled) throw readError('ACTION_DENIED'); return await page.screenshot({ type: 'png' }); }
        },
        clear: invalidate,
    };
}
