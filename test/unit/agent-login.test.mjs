import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { assertLoginNavigation, classifyLoginRequest, createLoginController, isLogoutUrl, waitForProfileRelease } from '../../skills/browser/agent-login.mjs';

const oldGetComputedStyle = globalThis.getComputedStyle;
afterEach(() => {
    if (oldGetComputedStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = oldGetComputedStyle;
});

async function submitWithMarkup(markup, beforeSubmit = () => {}) {
    const dom = new JSDOM(markup, { url: 'https://nid.naver.com/nidlogin.login', runScripts: 'outside-only' });
    const oldDocument = globalThis.document;
    const oldLocation = globalThis.location;
    globalThis.document = dom.window.document;
    globalThis.location = dom.window.location;
    let clicks = 0;
    const wrap = (element) => ({
        element,
        evaluate: async (fn, arg) => fn(element, arg && typeof arg === 'object' ? Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, value?.element ?? value])) : arg),
        evaluateHandle: async (fn) => wrap(fn(element)),
        fill: async (value) => { element.value = value; },
        dispose: async () => {},
    });
    const locator = (find) => ({
        count: async () => find().length,
        isVisible: async () => { const el = find()[0]; for (let node = el; node; node = node.parentElement) if (dom.window.getComputedStyle(node).display === 'none' || dom.window.getComputedStyle(node).visibility === 'hidden') return false; return Boolean(el?.isConnected); },
        elementHandle: async () => find()[0] ? wrap(find()[0]) : null,
        evaluate: async (fn) => fn(find()[0]),
        click: async () => { if (find()[0]) clicks += 1; },
        locator: (selector) => selector === 'xpath=ancestor::form[1]'
            ? locator(() => { const el = find()[0]; return el?.closest('form') ? [el.closest('form')] : []; })
            : locator(() => find().flatMap((el) => [...el.querySelectorAll(selector)])),
        filter: (options) => locator(() => find().filter((el) => { if (!options.visible) return true; for (let node = el; node; node = node.parentElement) if (dom.window.getComputedStyle(node).display === 'none' || dom.window.getComputedStyle(node).visibility === 'hidden') return false; return true; })),
    });
    const page = {
        url: () => dom.window.location.href,
        on() {},
        evaluate: async (fn, arg) => {
            const previous = globalThis.document;
            globalThis.document = dom.window.document;
            try { return fn(arg && typeof arg === 'object' ? Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, value?.element ?? value])) : arg); }
            finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
        },
        locator: (selector) => locator(() => [...dom.window.document.querySelectorAll(selector)]),
    };
    const controller = createLoginController(page);
    const filled = await controller.fillCredentials(async () => ({ result: 'credentials', account: 'operator', password: 'secret' }));
    expect(filled).toEqual({ result: 'filled', reason: 'none' });
    beforeSubmit();
    const result = await controller.submit();
    dom.window.close();
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
    return { result, clicks };
}

describe('agent login policy', () => {
    const realMarkup = (visible = 'column', action = 'https://nid.naver.com/nidlogin.login', outside = false) => `<form class="form" id="frmNIDLogin" name="frmNIDLogin" action="${action}" method="POST"><input id="id" name="id"><input id="pw" name="pw" type="password"><div class="btn_form column pc" style="display:${visible === 'column' || visible === 'both' ? 'block' : 'none'}"><ul class="btn_login_dual"><li class="dual_item passkey"><button type="button" id="passkeyBtn_column">패스키</button></li><li class="dual_item login"><button type="button" id="loginBtn_column">로그인</button></li></ul></div><div class="btn_form row" style="display:${visible === 'row' || visible === 'both' ? 'block' : 'none'}"><ul class="btn_login_dual"><li class="dual_item passkey"><button type="button" id="passkeyBtn_row">패스키</button></li><li class="dual_item login"><button type="button" id="loginBtn_row">로그인</button></li></ul></div></form>${outside ? '<button type="button" id="loginBtn_row">로그인</button>' : ''}`;
    it('clicks the visible column login button and never clicks passkey', async () => {
        const outcome = await submitWithMarkup(realMarkup('column'));
        expect(outcome).toEqual({ result: { result: 'submitted', reason: 'none' }, clicks: 1 });
    });
    it('clicks the visible row login button', async () => {
        const outcome = await submitWithMarkup(realMarkup('row'));
        expect(outcome).toEqual({ result: { result: 'submitted', reason: 'none' }, clicks: 1 });
    });
    it('fails unavailable when both variants are visible', async () => {
        const outcome = await submitWithMarkup(realMarkup('both'));
        expect(outcome).toEqual({ result: { result: 'failed', reason: 'button_unavailable' }, clicks: 0 });
    });
    it('fails unavailable when the login button is outside the form', async () => {
        const outcome = await submitWithMarkup(realMarkup('none', 'https://nid.naver.com/nidlogin.login', true));
        expect(outcome).toEqual({ result: { result: 'failed', reason: 'button_unavailable' }, clicks: 0 });
    });
    it('fails untrusted when the form action changes', async () => {
        const outcome = await submitWithMarkup(realMarkup('column'), () => { globalThis.document.querySelector('form').action = 'https://evil.example/login'; });
        expect(outcome).toEqual({ result: { result: 'failed', reason: 'button_untrusted' }, clicks: 0 });
    });
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
            evaluate: async (fn, arg) => fn(arg && typeof arg === 'object' ? Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, value?.element ?? value])) : arg),
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

    it('hands off captcha controls and masks every input and textarea during screenshots without handle locator()', async () => {
        const dom = new JSDOM('<form><input id="id" name="id"><input id="pw" name="pw" type="password"><input id="captcha" name="captcha"></form>', { url: 'https://nid.naver.com/nidlogin.login', runScripts: 'outside-only' });
        globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
        dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 });
        let screenshotOptions;
        const page = {
            url: () => dom.window.location.href, on() {},
            evaluate: async (fn, arg) => {
                const oldDocument = globalThis.document; const oldWindow = globalThis.window; const oldElement = globalThis.Element;
                globalThis.document = dom.window.document; globalThis.window = dom.window; globalThis.Element = dom.window.Element;
                try { return fn(arg && typeof arg === 'object' ? { ...arg, handles: (arg.handles || []).map((value) => value?.element ?? value) } : arg); }
                finally { if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument; if (oldWindow === undefined) delete globalThis.window; else globalThis.window = oldWindow; if (oldElement === undefined) delete globalThis.Element; else globalThis.Element = oldElement; }
            },
            $$: async (selector) => [...dom.window.document.querySelectorAll(selector)].map((element) => ({ evaluate: async (fn) => fn(element), fill: async () => {}, click: async () => {}, dispose: async () => {} })),
            screenshot: async (options) => { screenshotOptions = options; return Buffer.from('png'); },
        };
        const source = await readFile(new URL('../../skills/browser/agent-login.mjs', import.meta.url), 'utf8');
        expect(source).not.toMatch(/(?:handle|Handle)\.locator\s*\(/);
        const controller = createLoginController(page);
        const { controls } = await controller.snapshot();
        const captchaRef = controls[2].ref;
        await expect(controller.typeLoginText({ ref: captchaRef, text: '1234' })).rejects.toMatchObject({ code: 'HUMAN_REQUIRED' });
        await expect(controller.click({ ref: captchaRef })).rejects.toMatchObject({ code: 'HUMAN_REQUIRED' });
        await controller.screenshot();
        expect(screenshotOptions).toEqual({ type: 'png' });
        expect([...dom.window.document.querySelectorAll('input,textarea')].every((el) => el.style.visibility === '')).toBe(true);
        expect(dom.window.document.querySelectorAll('[data-login-screenshot-mask]').length).toBe(0);
        dom.window.close();
    });

    it('does not take a screenshot when masking evaluation fails', async () => {
        let screenshots = 0;
        const controller = createLoginController({ on() {}, evaluate: async () => { throw new Error('evaluate failed'); }, screenshot: async () => { screenshots += 1; } });
        await expect(controller.screenshot()).rejects.toMatchObject({ code: 'ACTION_DENIED' });
        expect(screenshots).toBe(0);
    });

    it('screenshots a real page with credential text hidden and restores styles when Chromium is available', async (context) => {
        let browser;
        try { browser = await chromium.launch(); } catch { context.skip(); return; }
        try {
            const page = await browser.newPage({ viewport: { width: 360, height: 180 } });
            await page.setContent('<style>body{margin:0;background:#fff}input{position:absolute;left:20px;width:240px;height:50px;border:0;outline:0;background:#fff;font:24px Arial}#id{top:30px}#pw{top:100px}</style><input id="id" name="id" value="secret-id"><input id="pw" type="password" value="secret-password">');
            const controller = createLoginController(page);
            const original = await page.locator('#id').evaluate((el) => el.getAttribute('style'));
            const shot = await controller.screenshot();
            const after = await page.locator('#id').evaluate((el) => el.getAttribute('style'));
            expect(shot.byteLength).toBeGreaterThan(0);
            expect(after).toBe(original);
            expect(await page.locator('[data-login-screenshot-mask]').count()).toBe(0);
            await page.locator('#id').evaluate((el) => { el.value = ''; });
            const blankReference = await page.screenshot({ type: 'png' });
            expect(shot.equals(blankReference)).toBe(true);
            await page.close();
        } finally { await browser.close(); }
    });

    it('fails closed when validated credential fields are replaced during keychain access', async () => {
        const dom = new JSDOM('<form action="/nidlogin.login"><input id="id" name="id"><input id="pw" name="pw" type="password"><button type="submit" class="btn_login" id="log.login"><span class="btn_text">로그인</span></button></form>', { url: 'https://nid.naver.com/nidlogin.login', runScripts: 'outside-only' });
        const oldDocument = globalThis.document;
        const oldLocation = globalThis.location;
        globalThis.document = dom.window.document;
        globalThis.location = dom.window.location;
        globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
        dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 20 });
        let fills = 0;
        const wrap = (element) => ({
            element, evaluate: async (fn, arg) => fn(element, arg && typeof arg === 'object' ? Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, value?.element ?? value])) : arg),
            evaluateHandle: async (fn) => wrap(fn(element)), fill: async () => { fills += 1; }, click: async () => {}, dispose: async () => {},
        });
        const page = {
            url: () => dom.window.location.href, on() {},
            evaluate: async (fn, arg) => fn(arg && typeof arg === 'object' ? Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, value?.element ?? value])) : arg),
            locator: (selector) => {
                const find = () => dom.window.document.querySelector(selector);
                return { count: async () => find() ? 1 : 0, isVisible: async () => Boolean(find()), evaluate: async (fn) => fn(find()), elementHandle: async () => find() ? wrap(find()) : null };
            },
            $$: async () => [],
        };
        const controller = createLoginController(page);
        const outcome = await controller.fillCredentials(async () => {
            dom.window.document.querySelector('#id').name = 'renamed';
            return { result: 'credentials', account: 'account', password: 'password' };
        });
        expect(outcome).toEqual({ result: 'failed', reason: 'fields_changed' });
        expect(fills).toBe(0);
        dom.window.close();
        if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
        if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
    });

    it.each([
        ['moves the password field to an untrusted form and changes its type', (dom) => {
            const form = dom.window.document.createElement('form');
            form.action = 'https://example.invalid/collect';
            const password = dom.window.document.querySelector('#pw');
            password.type = 'text';
            form.append(password);
            dom.window.document.body.append(form);
        }],
        ['changes the validated form action in place', (dom) => {
            dom.window.document.querySelector('form').action = 'https://nid.naver.com/collect';
        }],
        ['navigates the top-level page during keychain access', (dom) => {
            dom.window.history.pushState({}, '', 'https://example.invalid/collect');
        }],
    ])('fails closed when keychain access %s', async (_description, mutate) => {
        const dom = new JSDOM('<form action="/nidlogin.login"><input id="id" name="id"><input id="pw" name="pw" type="password"></form>', { url: 'https://nid.naver.com/nidlogin.login', runScripts: 'outside-only' });
        const oldDocument = globalThis.document;
        const oldLocation = globalThis.location;
        globalThis.document = dom.window.document;
        globalThis.location = dom.window.location;
        let filled = 0;
        const wrap = (element) => ({
            element,
            evaluate: async (fn, arg) => fn(element, arg && typeof arg === 'object' ? Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, value?.element ?? value])) : arg),
            evaluateHandle: async (fn) => wrap(fn(element)),
            fill: async () => { filled += 1; }, dispose: async () => {},
        });
        const page = {
            url: () => dom.window.location.href, on() {}, evaluate: async (fn, arg) => fn(arg && typeof arg === 'object' ? Object.fromEntries(Object.entries(arg).map(([key, value]) => [key, value?.element ?? value])) : arg),
            locator: (selector) => {
                const find = () => dom.window.document.querySelector(selector);
                return { count: async () => find() ? 1 : 0, isVisible: async () => Boolean(find()), evaluate: async (fn) => fn(find()), elementHandle: async () => find() ? wrap(find()) : null };
            },
        };
        const controller = createLoginController(page);
        const outcome = await controller.fillCredentials(async () => {
            mutate(dom);
            return { result: 'credentials', account: 'account', password: 'password' };
        });
        expect(outcome.result).toBe('failed');
        expect(filled).toBe(0);
        dom.window.close();
        if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
        if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
    });
});
