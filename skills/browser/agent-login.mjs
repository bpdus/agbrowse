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
        || host === 'ncpt.naver.com' || host === 'nca.naver.com') && ['GET', 'HEAD'].includes(verb)) return 'allow';
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
    let credentialMaskHandles = null;
    const protectedIdentity = new Set();
    let revision = 0;
    let snapshotSeq = 0;
    let credentialsFilled = false;
    const disposeRefs = (items) => {
        for (const item of items.values()) void item.handle.dispose().catch(() => {});
    };
    const invalidate = () => { const old = refs; refs = new Map(); revision += 1; disposeRefs(old); };
    const clearCredentialMaskHandles = () => {
        if (!credentialMaskHandles) return;
        for (const handle of credentialMaskHandles) void handle.dispose().catch(() => {});
        credentialMaskHandles = null;
    };
    page.on?.('framenavigated', (frame) => { if (!page.mainFrame || frame === page.mainFrame()) { invalidate(); clearCredentialMaskHandles(); } });

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

    async function ensureHumanMayContinue(target = null) {
        if (target && await target.evaluate((el) => /captcha|ncpt/i.test(`${el.id || ''} ${el.getAttribute('name') || ''} ${el.getAttribute('class') || ''} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''}`)).catch(() => true)) throw readError('HUMAN_REQUIRED');
        if (typeof page.evaluate === 'function' && await Promise.resolve().then(() => page.evaluate(classifyLoginProgress)).catch(() => 'needs_human') === 'needs_human') throw readError('HUMAN_REQUIRED');
    }

    return {
        snapshot: snapshotLoginPage,
        async click(input) {
            if (input && Object.hasOwn(input, 'ref')) {
                if (typeof input.ref !== 'string') throw readError('REF_STALE');
                const item = resolveLoginRef(input.ref);
                await ensureHumanMayContinue(item.handle);
                if (credentialsFilled && await item.handle.evaluate((el) => Boolean(el.closest('form')?.querySelector('#id[name="id"],#pw[name="pw"]')))) throw readError('ACTION_DENIED');
                await (await handleFor(item)).click();
            }
            else if (Number.isFinite(input?.x) && Number.isFinite(input?.y)) {
                await ensureHumanMayContinue();
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
                const item = resolveLoginRef(input.ref);
                await ensureHumanMayContinue(item.handle);
                await (await handleFor(item)).fill(input.text);
            }
            else {
                const focused = page.locator(':focus');
                await ensureHumanMayContinue(focused);
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
            await ensureHumanMayContinue(focused);
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
            let idHandle = null; let passwordHandle = null; let formHandle = null;
            try {
                await ensureHumanMayContinue();
                if (new URL(page.url()).origin !== 'https://nid.naver.com' || new URL(page.url()).pathname !== '/nidlogin.login') return { result: 'failed', reason: 'wrong_page' };
                const ids = page.locator('input#id[name="id"]'); const passwords = page.locator('input#pw[name="pw"]');
                if (await ids.count() !== 1 || await passwords.count() !== 1 || !await ids.isVisible() || !await passwords.isVisible()) return { result: 'failed', reason: 'fields_unavailable' };
                idHandle = await ids.elementHandle(); passwordHandle = await passwords.elementHandle();
                if (!idHandle || !passwordHandle) return { result: 'failed', reason: 'fields_unavailable' };
                const expected = await page.evaluate(({ idField, passwordField }) => {
                    const id = idField; const password = passwordField; const form = id.form;
                    const Input = id.ownerDocument.defaultView?.HTMLInputElement;
                    if (!Input || !(id instanceof Input) || !(password instanceof Input) || !form || password.form !== form) return null;
                    const action = new URL(form.getAttribute('action') ?? '', document.baseURI);
                    if (location.origin !== 'https://nid.naver.com' || action.protocol !== 'https:' || action.host !== 'nid.naver.com' || action.pathname !== '/nidlogin.login') return null;
                    if (!['text', 'email', 'tel'].includes(id.type) || password.type !== 'password') return null;
                    return { id: { id: id.id, name: id.name, type: id.type }, password: { id: password.id, name: password.name, type: password.type } };
                }, { idField: idHandle, passwordField: passwordHandle }).catch(() => null);
                if (!expected) return { result: 'failed', reason: 'fields_untrusted' };
                formHandle = await idHandle.evaluateHandle((el) => el.form);
                if (!formHandle || await formHandle.evaluate((form) => !form)) return { result: 'failed', reason: 'fields_untrusted' };
                const values = await readCredentials();
                if (values?.result !== 'credentials') {
                    const reasons = new Set(['invalid_input','account_unavailable','keychain_read_failed','state_unsafe']);
                    return { result: 'failed', reason: reasons.has(values?.reason) ? values.reason : 'credentials_unavailable' };
                }
                await ensureHumanMayContinue();
                const recheck = async (targetName) => page.evaluate(({ idField, passwordField, form, expected, targetName }) => {
                    const id = idField; const password = passwordField; const retainedForm = form;
                    if (!id.isConnected || !password.isConnected || !retainedForm.isConnected || id.form !== retainedForm || password.form !== retainedForm || !retainedForm.contains(id) || !retainedForm.contains(password)) return false;
                    if (location.origin !== 'https://nid.naver.com') return false;
                    let action; try { action = new URL(retainedForm.getAttribute('action') ?? '', document.baseURI); } catch { return false; }
                    if (action.protocol !== 'https:' || action.host !== 'nid.naver.com' || action.pathname !== '/nidlogin.login') return false;
                    if (id.id !== expected.id.id || id.name !== expected.id.name || !['text', 'email', 'tel'].includes(id.type) || id.type !== expected.id.type) return false;
                    if (password.id !== expected.password.id || password.name !== expected.password.name || password.type !== 'password' || password.type !== expected.password.type) return false;
                    return targetName === 'id' ? id === idField : password === passwordField;
                }, { idField: idHandle, passwordField: passwordHandle, form: formHandle, expected, targetName }).catch(() => false);
                if (!await recheck('id')) return { result: 'failed', reason: 'fields_changed' };
                protectedIdentity.add('input|pw|pw|'); credentialsFilled = true;
                clearCredentialMaskHandles();
                credentialMaskHandles = [idHandle, passwordHandle];
                await idHandle.fill(values.account);
                if (!await recheck('password')) return { result: 'failed', reason: 'fields_changed' };
                await passwordHandle.fill(values.password);
                idHandle = null; passwordHandle = null; formHandle = null;
                invalidate();
                return { result: 'filled', reason: 'none' };
            } catch { return { result: 'failed', reason: 'fill_failed' }; }
            finally { await Promise.all([idHandle, passwordHandle, formHandle].filter((handle) => handle && !credentialMaskHandles?.includes(handle)).map((handle) => handle.dispose().catch(() => {}))); }
        },
        async submit() {
            try {
                await ensureHumanMayContinue();
                if (!credentialsFilled || new URL(page.url()).origin !== 'https://nid.naver.com' || new URL(page.url()).pathname !== '/nidlogin.login') return { result: 'failed', reason: 'not_filled' };
                const loginForm = page.locator('form#frmNIDLogin');
                if (await loginForm.count() !== 1) return { result: 'failed', reason: 'button_unavailable' };
                const candidates = loginForm.locator('button#loginBtn_column, button#loginBtn_row').filter({ visible: true });
                if (await candidates.count() !== 1) return { result: 'failed', reason: 'button_unavailable' };
                const button = candidates;
                const valid = await button.evaluate((el) => {
                    const form = el.closest('form');
                    if (!form || form.getAttribute('id') !== 'frmNIDLogin' || !form.isConnected || !form.contains(el) || location.origin !== 'https://nid.naver.com') return false;
                    let action; try { action = new URL(form.getAttribute('action') ?? '', document.baseURI); } catch { return false; }
                    return action.protocol === 'https:' && action.host === 'nid.naver.com' && action.pathname === '/nidlogin.login'
                        && form.querySelector('input#id[name="id"]')?.form === form
                        && form.querySelector('input#pw[name="pw"]')?.form === form
                        && ['button', 'submit'].includes(el.type);
                });
                if (!valid) return { result: 'failed', reason: 'button_untrusted' };
                await button.click(); credentialsFilled = false; invalidate(); return { result: 'submitted', reason: 'none' };
            } catch { return { result: 'failed', reason: 'submit_failed' }; }
        },
        async checkProgress() {
            try { return { status: await page.evaluate(classifyLoginProgress) }; } catch { return { status: 'unknown' }; }
        },
        async screenshot() {
            const maskKey = `__loginScreenshotMask_${nonce}`;
            try {
                await page.evaluate(({ handles, key }) => {
                    const elements = new Set([...document.querySelectorAll('input,textarea'), ...handles]);
                    const saved = [];
                    try {
                        for (const element of elements) {
                            if (!(element instanceof Element) || !element.isConnected) continue;
                            const style = element.style;
                            saved.push({ element, visibility: style.getPropertyValue('visibility'), priority: style.getPropertyPriority('visibility') });
                            style.setProperty('visibility', 'hidden');
                            const rect = element.getBoundingClientRect();
                            const overlay = document.createElement('div');
                            Object.assign(overlay.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, background: '#fff', opacity: '1', zIndex: '2147483647', pointerEvents: 'none' });
                            overlay.setAttribute('data-login-screenshot-mask', key);
                            (document.documentElement || document.body).appendChild(overlay);
                        }
                        window[key] = saved;
                    } catch (error) {
                        for (const item of saved) {
                            if (item.visibility) item.element.style.setProperty('visibility', item.visibility, item.priority);
                            else item.element.style.removeProperty('visibility');
                        }
                        document.querySelectorAll(`[data-login-screenshot-mask="${key}"]`).forEach((overlay) => overlay.remove());
                        throw error;
                    }
                }, { handles: credentialMaskHandles ?? [], key: maskKey });
                return await page.screenshot({ type: 'png' });
            } catch {
                throw readError('ACTION_DENIED');
            } finally {
                await page.evaluate((key) => {
                    const saved = window[key] || [];
                    for (const item of saved) {
                        if (item.visibility) item.element.style.setProperty('visibility', item.visibility, item.priority);
                        else item.element.style.removeProperty('visibility');
                    }
                    document.querySelectorAll(`[data-login-screenshot-mask="${key}"]`).forEach((overlay) => overlay.remove());
                    delete window[key];
                }, maskKey).catch(() => {});
            }
        },
        clear() { invalidate(); clearCredentialMaskHandles(); },
    };
}
