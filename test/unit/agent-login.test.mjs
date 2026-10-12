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
});
