import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { createLoginController } from '../../skills/browser/agent-login.mjs';

const oldDocument = globalThis.document;
const oldGetComputedStyle = globalThis.getComputedStyle;
afterEach(() => {
    if (oldDocument === undefined) delete globalThis.document; else globalThis.document = oldDocument;
    if (oldGetComputedStyle === undefined) delete globalThis.getComputedStyle; else globalThis.getComputedStyle = oldGetComputedStyle;
});
function pageWith(html) {
    const dom = new JSDOM(html, { url: 'https://nid.naver.com/nidlogin.login' });
    globalThis.document = dom.window.document;
    globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
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
        locator() { return { async evaluate(fn) { return fn(dom.window.document.activeElement); }, async fill(value) { dom.window.document.activeElement.value = value; } }; },
        mouse: { async click(...args) { this.last = args; } },
        keyboard: { async press(key) { this.last = key; } },
    };
}

describe('login controller', () => {
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
