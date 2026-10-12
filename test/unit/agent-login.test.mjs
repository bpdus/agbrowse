import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { assertLoginNavigation, classifyLoginRequest, createLoginController, isLogoutUrl, waitForProfileRelease } from '../../skills/browser/agent-login.mjs';

const oldGetComputedStyle = globalThis.getComputedStyle;
afterEach(() => {
    if (oldGetComputedStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = oldGetComputedStyle;
});

describe('agent login policy', () => {
    it('blocks logout and non-allowlisted destinations before request handling', () => {
        expect(isLogoutUrl('https://nid.naver.com/nidlogin.logout?foo=1')).toBe(true);
        expect(classifyLoginRequest('https://nid.naver.com/nidlogin.logout?foo=1', 'GET')).toBe('deny');
        expect(classifyLoginRequest('https://example.com/', 'GET')).toBe('deny');
        expect(classifyLoginRequest('https://evilpstatic.net/a.js', 'GET')).toBe('deny');
    });
    it('allows only secure login and static resource requests', () => {
        expect(classifyLoginRequest('https://nid.naver.com/nidlogin.login', 'POST')).toBe('allow');
        expect(classifyLoginRequest('https://ssl.pstatic.net/a.js', 'GET')).toBe('allow');
        expect(classifyLoginRequest('https://ncpt.naver.com/static/ncaptcha-api.js', 'GET')).toBe('allow');
        expect(classifyLoginRequest('http://nid.naver.com/nidlogin.login', 'GET')).toBe('deny');
        expect(classifyLoginRequest('https://ncpt.naver.com/challenge', 'POST')).toBe('deny');
    });
    it('waits for all Chrome profile locks and times out without removing them', async () => {
        let lockCalls = 0;
        const fakeFs = { promises: { async lstat() { lockCalls += 1; if (lockCalls === 1) return {}; const error = new Error(); error.code = 'ENOENT'; throw error; } } };
        await waitForProfileRelease('/profile', { fs: fakeFs, intervalMs: 1, timeoutMs: 20 });
        expect(lockCalls).toBeGreaterThan(3);
        const lockedFs = { promises: { async lstat() { return {}; } } };
        await expect(waitForProfileRelease('/profile', { fs: lockedFs, intervalMs: 1, timeoutMs: 4 })).rejects.toMatchObject({ code: 'PROFILE_RELEASE_TIMEOUT' });
    });

    it('restricts top-level navigation to the login page', () => {
        expect(assertLoginNavigation('https://nid.naver.com/nidlogin.login')).toBe('https://nid.naver.com/nidlogin.login');
        expect(() => assertLoginNavigation('https://nid.naver.com/nidlogin.logout')).toThrow();
        expect(() => assertLoginNavigation('https://naver.com/')).toThrow();
        expect(() => assertLoginNavigation('https://user:pass@nid.naver.com/nidlogin.login')).toThrow();
    });

    it('binds visible refs to their real selector elements when hidden inputs precede them', async () => {
        const dom = new JSDOM('<input type="hidden" name="csrf"><input name="username" placeholder="Username">', { url: 'https://nid.naver.com/nidlogin.login', runScripts: 'outside-only' });
        globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
        dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return this.type === 'hidden' ? { width: 0, height: 0 } : { width: 100, height: 20 }; };
        const selector = 'a,button,input,select,textarea,[role="button"],[role="link"],[tabindex]';
        const all = [...dom.window.document.querySelectorAll(selector)];
        let filled = null;
        const page = {
            url: () => dom.window.location.href,
            on() {},
            evaluate: (fn) => dom.window.Function(`return (${fn.toString()})()`)(),
        $$: async (selector) => [...dom.window.document.querySelectorAll(selector)].map((element) => ({
            evaluate: async (fn) => fn(element),
            fill: async (value) => { filled = { element, value }; },
            dispose: async () => {},
        })),
        };
        const controller = createLoginController(page);
        const { controls } = await controller.snapshot();
        expect(controls).toHaveLength(1);
        await controller.typeLoginText({ ref: controls[0].ref, text: 'operator' });
        expect(filled).toEqual({ element: all[1], value: 'operator' });
        const refreshed = await controller.snapshot();
        all[1].setAttribute('name', 'changed');
        await expect(controller.typeLoginText({ ref: refreshed.controls[0].ref, text: 'operator' })).rejects.toMatchObject({ code: 'REF_STALE' });
        dom.window.close();
    });

    it('rejects refs from older snapshots after controls change', async () => {
        const dom = new JSDOM('<button aria-label="Continue">Continue</button><button aria-label="Cancel">Cancel</button>', { url: 'https://nid.naver.com/nidlogin.login', runScripts: 'outside-only' });
        globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
        dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 });
        const selector = 'a,button,input,select,textarea,[role="button"],[role="link"],[tabindex]';
        let cancelClicked = false;
        const page = {
            url: () => dom.window.location.href,
            on() {},
            $$: async () => [...dom.window.document.querySelectorAll(selector)].map((element) => ({
                evaluate: async (fn) => fn(element),
                click: async () => { if (element.textContent === 'Cancel') cancelClicked = true; },
                dispose: async () => {},
            })),
        };
        const controller = createLoginController(page);
        const first = await controller.snapshot();
        const continueRef = first.controls.find((control) => control.label === 'Continue').ref;
        expect(continueRef).toMatch(/^[a-f0-9]{16}_s1_\d+$/);

        dom.window.document.querySelector('button').remove();
        const second = await controller.snapshot();
        expect(second.controls.map((control) => control.label)).toEqual(['Cancel']);
        expect(second.controls[0].ref).toMatch(/^[a-f0-9]{16}_s2_\d+$/);
        await expect(controller.click({ ref: continueRef })).rejects.toMatchObject({ code: 'REF_STALE' });
        expect(cancelClicked).toBe(false);
        dom.window.close();
    });

    it('rejects refs from a previous controller generation and malformed refs without clicking', async () => {
        const dom = new JSDOM('<button aria-label="Continue">Continue</button>', { url: 'https://nid.naver.com/nidlogin.login', runScripts: 'outside-only' });
        globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
        dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 });
        const selector = 'a,button,input,select,textarea,[role="button"],[role="link"],[tabindex]';
        let clicks = 0;
        const page = {
            url: () => dom.window.location.href,
            on() {},
            $$: async () => [...dom.window.document.querySelectorAll(selector)].map((element) => ({
                evaluate: async (fn) => fn(element),
                click: async () => { clicks += 1; },
                dispose: async () => {},
            })),
        };
        const firstSession = createLoginController(page);
        const oldRef = (await firstSession.snapshot()).controls[0].ref;
        const restartedSession = createLoginController(page);
        const freshRef = (await restartedSession.snapshot()).controls[0].ref;
        expect(freshRef).not.toBe(oldRef);
        await expect(restartedSession.click({ ref: oldRef })).rejects.toMatchObject({ code: 'REF_STALE' });
        await expect(restartedSession.click({ ref: 's1_1' })).rejects.toMatchObject({ code: 'REF_STALE' });
        await expect(restartedSession.click({ ref: 1 })).rejects.toMatchObject({ code: 'REF_STALE' });
        expect(clicks).toBe(0);
        dom.window.close();
    });

    it('hands off captcha controls and masks both credential fields in screenshots', async () => {
        const dom = new JSDOM('<form><input id="id" name="id"><input id="pw" name="pw" type="password"><input id="captcha" name="captcha"></form>', { url: 'https://nid.naver.com/nidlogin.login', runScripts: 'outside-only' });
        globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
        dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 });
        let screenshotOptions;
        const page = {
            url: () => dom.window.location.href, on() {},
            evaluate: (fn) => dom.window.Function(`return (${fn.toString()})()`)(),
            $$: async (selector) => [...dom.window.document.querySelectorAll(selector)].map((element) => ({ evaluate: async (fn) => fn(element), fill: async () => {}, click: async () => {}, dispose: async () => {} })),
            locator: (selector) => ({ selector, evaluate: async (fn) => fn(dom.window.document.querySelector(selector)), count: async () => 1, isVisible: async () => true }),
            screenshot: async (options) => { screenshotOptions = options; return Buffer.from('png'); },
        };
        const controller = createLoginController(page);
        const { controls } = await controller.snapshot();
        const captchaRef = controls[2].ref;
        await expect(controller.typeLoginText({ ref: captchaRef, text: '1234' })).rejects.toMatchObject({ code: 'HUMAN_REQUIRED' });
        await expect(controller.click({ ref: captchaRef })).rejects.toMatchObject({ code: 'HUMAN_REQUIRED' });
        await controller.screenshot();
        expect(screenshotOptions.mask).toHaveLength(2);
        expect(screenshotOptions.mask.map((locator) => locator.selector)).toEqual(['input#id[name="id"]', 'input#pw[name="pw"]']);
        dom.window.close();
    });

    it('fails closed when validated credential fields are replaced during keychain access', async () => {
        const dom = new JSDOM('<form><input id="id" name="id"><input id="pw" name="pw" type="password"><button id="log" class="login">Login</button></form>', { url: 'https://nid.naver.com/nidlogin.login', runScripts: 'outside-only' });
        const oldDocument = globalThis.document;
        const oldLocation = globalThis.location;
        globalThis.document = dom.window.document;
        globalThis.location = dom.window.location;
        globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
        dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 });
        let fills = 0;
        const wrap = (element) => ({
            evaluate: async (fn, arg) => fn(element, arg), fill: async () => { fills += 1; }, click: async () => {}, dispose: async () => {},
        });
        const page = {
            url: () => dom.window.location.href, on() {},
            evaluate: (fn) => dom.window.Function(`return (${fn.toString()})()`)(),
            locator: (selector) => {
                const find = () => dom.window.document.querySelector(selector);
                return { count: async () => find() ? 1 : 0, isVisible: async () => Boolean(find()), evaluate: async (fn) => fn(find()), elementHandle: async () => find() ? wrap(find()) : null };
            },
            $$: async () => [],
        };
        const controller = createLoginController(page);
        const outcome = await controller.fillCredentials(async () => {
            const replacement = dom.window.document.createElement('input');
            replacement.id = 'id'; replacement.name = 'id';
            dom.window.document.querySelector('#id').replaceWith(replacement);
            return { result: 'credentials', account: 'account', password: 'password' };
        });
        expect(outcome).toEqual({ result: 'failed', reason: 'fields_changed' });
        expect(fills).toBe(0);
        dom.window.close();
        if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
        if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
    });
});
