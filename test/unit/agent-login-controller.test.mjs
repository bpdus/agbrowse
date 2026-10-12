import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyLoginProgress, createLoginController } from '../../skills/browser/agent-login.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const oldDocument = globalThis.document;
const oldGetComputedStyle = globalThis.getComputedStyle;
const oldLocation = globalThis.location;
afterEach(() => {
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldGetComputedStyle === undefined) delete globalThis.getComputedStyle; else globalThis.getComputedStyle = oldGetComputedStyle;
    if (oldLocation === undefined) delete globalThis.location; else globalThis.location = oldLocation;
});
function pageWith(html) {
    const dom = new JSDOM(html, { url: 'https://nid.naver.com/nidlogin.login' });
    globalThis.document = dom.window.document;
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    globalThis.location = dom.window.location;
    dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 20, height: 20 });
    const listeners = {};
    const elements = [...dom.window.document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"],[tabindex]')];
    return {
        dom, listeners, calls: [],
        on(name, cb) { listeners[name] = cb; }, mainFrame() { return 'main'; },
        url() { return dom.window.location.href; },
        async evaluate(fn) { return fn(); },
        async $$(selector) { return [...dom.window.document.querySelectorAll(selector)].map((el) => ({
            async evaluate(fn) { return fn(el); },
            async fill(value) { el.value = value; }, async click() { el.click(); },
            async dispose() {},
        })); },
        locator(selector) { return { async count() { return dom.window.document.querySelectorAll(selector).length; }, async isVisible() { return true; }, async evaluate(fn) { return fn(dom.window.document.querySelector(selector) ?? dom.window.document.activeElement); }, async elementHandle() { const el = dom.window.document.querySelector(selector); return el ? { async evaluate(fn, arg) { return fn(el, arg); }, async fill(value) { el.value = value; }, async dispose() {} } : null; }, async fill(value) { dom.window.document.querySelector(selector).value = value; }, async click() { dom.window.document.querySelector(selector).click(); } }; },
        mouse: { async click(...args) { this.last = args; } },
        keyboard: { async press(key) { this.last = key; } },
    };
}

describe('login controller', () => {
    it('classifies sanitized progress fixtures with challenge precedence', () => {
        const expected = { 'login-page.html':'login_page', 'needs-human.html':'needs_human', 'phone-approval.html':'needs_phone_approval', 'logged-in.html':'logged_in', 'unknown.html':'unknown', 'overlap.html':'needs_human' };
        for (const [file, status] of Object.entries(expected)) {
            const dom = new JSDOM(readFileSync(fileURLToPath(new URL(`../fixtures/agent-login-progress/${file}`, import.meta.url)), 'utf8'), { url: 'https://nid.naver.com/nidlogin.login' });
            dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 20, height: 20 });
            expect(classifyLoginProgress(dom.window.document), file).toBe(status);
        }
    });
    it('does not classify a captcha script alone as a human challenge', () => {
        const dom = new JSDOM('<script src="https://ncpt.naver.com/static/captcha.js"></script>');
        expect(classifyLoginProgress(dom.window.document)).toBe('unknown');
    });
    it('fills the exact trusted fields without submitting, then submits only explicitly', async () => {
        const page = pageWith('<form action="/nidlogin.login"><input id="id" name="id"><input id="pw" name="pw" type="password"><button id="log" class="login" type="submit">Log in</button></form>');
        let submits = 0;
        page.dom.window.document.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); submits += 1; });
        const controller = createLoginController(page);
        expect(await controller.fillCredentials(async () => ({ result: 'credentials', account: 'account-sentinel', password: 'password-sentinel' }))).toEqual({ result: 'filled', reason: 'none' });
        expect(submits).toBe(0);
        expect(page.dom.window.document.querySelector('#id').value).toBe('account-sentinel');
        expect(page.dom.window.document.querySelector('#pw').value).toBe('password-sentinel');
        page.dom.window.document.querySelector('#pw').type = 'text';
        const snap = await controller.snapshot();
        expect(JSON.stringify(snap)).not.toContain('password-sentinel');
        expect(snap.controls.find((item) => item.type === 'password').label).toBe('');
        await expect(controller.pressLoginKey('Enter')).rejects.toMatchObject({ code: 'ACTION_DENIED' });
        await expect(controller.submit()).resolves.toMatchObject({ result: 'submitted' });
        expect(submits).toBe(1);
    });
    it('redacts password controls and refuses password typing, including revealed fields', async () => {
        const page = pageWith('<input name="id" autocomplete="username"><input id="pw" name="password" type="password" autocomplete="current-password">');
        const controller = createLoginController(page);
        const snap = await controller.snapshot();
        expect(snap.controls[1]).toMatchObject({ type: 'password', redacted: true });
        expect(JSON.stringify(snap)).not.toContain('value');
        await expect(controller.typeLoginText({ ref: snap.controls[1].ref, text: 'sentinel-secret' })).rejects.toMatchObject({ code: 'PASSWORD_REFUSED' });
        page.dom.window.document.querySelector('#pw').type = 'text';
        await expect(controller.typeLoginText({ ref: snap.controls[1].ref, text: 'sentinel-secret' })).rejects.toMatchObject({ code: 'PASSWORD_REFUSED' });
    });
    it('expires refs after navigation and rejects shortcuts outside the key set', async () => {
        const page = pageWith('<button>Continue</button>');
        const controller = createLoginController(page);
        const snap = await controller.snapshot();
        page.listeners.framenavigated('main');
        await expect(controller.click({ ref: snap.controls[0].ref })).rejects.toMatchObject({ code: 'REF_STALE' });
        await expect(controller.pressLoginKey('Meta+Q')).rejects.toMatchObject({ code: 'ACTION_DENIED' });
    });
    it('rejects refs when their original element is removed or replaced', async () => {
        const page = pageWith('<button>Continue</button><button>Cancel</button>');
        const controller = createLoginController(page);
        const snap = await controller.snapshot();
        const buttons = [...page.dom.window.document.querySelectorAll('button')];
        let cancelClicks = 0;
        buttons[1].addEventListener('click', () => { cancelClicks += 1; });
        buttons[0].remove();
        await expect(controller.click({ ref: snap.controls[0].ref })).rejects.toMatchObject({ code: 'REF_STALE' });
        expect(cancelClicks).toBe(0);

        const replaced = await controller.snapshot();
        const original = page.dom.window.document.querySelector('button');
        const replacement = original.cloneNode(true);
        original.replaceWith(replacement);
        await expect(controller.click({ ref: replaced.controls[0].ref })).rejects.toMatchObject({ code: 'REF_STALE' });
        expect(cancelClicks).toBe(0);
    });
});
