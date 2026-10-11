import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { sanitizeNaverTopbarStructure } from '../../skills/browser/agent-naver-topbar.mjs';

describe('Naver top-bar sanitizer', () => {
    it('keeps only the selected structure and removes text, labels, and URL secrets', () => {
        const dom = new JSDOM(`<!doctype html>
            <header id="header" class="topbar" role="banner" aria-label="Private Person">
                <div id="gnb" class="gnb">
                    <span>Fake Name: Han Test</span>
                    <a class="link_login" href="https://nid.naver.com/nidlogin.login?email=fake@example.test#cookie=secret-cookie">Fake Email: fake@example.test</a>
                    <button aria-label="Private Person signed in">Fake cookie: session-secret</button>
                    <img src="https://static.example.test/avatar/private-person.jpg" alt="Fake Name: Han Test">
                    <iframe src="https://frame.example.test/profile/private-person?cookie=frame-secret"></iframe>
                </div>
            </header>
            <div id="account" class="MyView_account" data-clk="account">Account label: fake@example.test</div>
            <main>Unrelated Private Person</main>`);

        const html = sanitizeNaverTopbarStructure(dom.window.document);

        expect(html).toContain('<header class="topbar" id="header" role="banner" aria-label="LABEL">');
        expect(html).toContain('href="https://nid.naver.com/nidlogin.login"');
        expect(html).toContain('<iframe data-src-origin="https://frame.example.test"></iframe>');
        expect(html).toContain('class="MyView_account" id="account" data-clk="account"');
        for (const secret of [
            'Han Test', 'fake@example.test', 'session-secret', 'private-person', 'cookie=frame-secret',
            'Private Person', 'Unrelated', 'avatar', 'src=', 'alt=',
        ]) {
            expect(html).not.toContain(secret);
        }
        const sanitized = new JSDOM(`<body>${html}</body>`).window.document.body;
        for (const element of sanitized.querySelectorAll('*')) {
            const allowed = element.tagName.toLowerCase() === 'iframe'
                ? ['data-src-origin']
                : ['class', 'id', 'role', 'aria-label', 'href', 'data-clk'];
            expect([...element.attributes].every((attribute) => allowed.includes(attribute.name))).toBe(true);
        }
        expect([...sanitized.querySelectorAll('*')].flatMap((element) => [...element.childNodes])
            .filter((node) => node.nodeType === 3)
            .every((node) => node.textContent === 'TEXT')).toBe(true);
        expect([...sanitized.querySelectorAll('iframe')]).toHaveLength(1);
    });

    it('caps serialization at 4000 elements', () => {
        const children = '<span>safe</span>'.repeat(4100);
        const dom = new JSDOM(`<header>${children}</header>`);
        const html = sanitizeNaverTopbarStructure(dom.window.document);
        expect((html.match(/<span>/g) || [])).toHaveLength(3999);
        expect((html.match(/<[a-z][a-z0-9-]*(?:\s[^>]*)?>/gi) || [])).toHaveLength(4000);
    });
});
