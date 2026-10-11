import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
    LOGIN_STATUS_ACCOUNT_PATH,
    LOGIN_STATUS_LOGIN_PATH,
    LOGIN_STATUS_ORIGIN,
    LOGIN_STATUS_URL,
    classifyLoginStatusRequest,
    loginStatusPolicy,
    readLoginStatusFromDocument,
    readLoginStatusFromFinalUrl,
    readLoginStatusFromPage,
} from '../../skills/browser/agent-naver-login-status.mjs';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`../fixtures/agent-login-status/${name}.html`, import.meta.url)), 'utf8');

function fixtureDocument(name) {
    const dom = new JSDOM(fixture(name), { url: LOGIN_STATUS_URL });
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', {
        configurable: true,
        value() { return [{}]; },
    });
    return dom.window.document;
}

describe('Naver login status adapter', () => {
    it('classifies fixed auth targets anywhere in the document, with logout taking precedence', () => {
        expect(readLoginStatusFromDocument(fixtureDocument('logged-out')))
            .toEqual({ status: 'logged_out', evidence: 'login_link' });
        expect(readLoginStatusFromDocument(fixtureDocument('logged-in')))
            .toEqual({ status: 'logged_in', evidence: 'logout_link' });
        expect(readLoginStatusFromDocument(fixtureDocument('unknown')))
            .toEqual({ status: 'unknown', evidence: 'none' });
        expect(readLoginStatusFromDocument(fixtureDocument('both')))
            .toEqual({ status: 'logged_in', evidence: 'logout_link' });
    });

    it.each([
        'http://nid.naver.com/nidlogin.logout',
        'ftp://nid.naver.com/nidlogin.logout',
        'https://attacker.test@nid.naver.com/nidlogin.logout',
    ])('returns unknown for an unsafe auth URL: %s', (href) => {
        const dom = new JSDOM('<a></a>', { url: LOGIN_STATUS_URL });
        dom.window.document.querySelector('a').setAttribute('href', href);

        expect(readLoginStatusFromDocument(dom.window.document))
            .toEqual({ status: 'unknown', evidence: 'none' });
    });

    it('never returns fixture names, email addresses, or page-derived values', () => {
        for (const name of ['logged-in', 'logged-out', 'unknown', 'both']) {
            const result = readLoginStatusFromDocument(fixtureDocument(name));
            expect(Object.keys(result).sort()).toEqual(['evidence', 'status']);
            expect(['logged_in', 'logged_out', 'unknown']).toContain(result.status);
            expect(['logout_link', 'login_link', 'none']).toContain(result.evidence);
            expect(JSON.stringify(result)).not.toMatch(/Fixture Private Name|fixture\.private@example\.test|nidlogin\.(?:login|logout)|https?:\/\//i);
        }
    });

    it('classifies only exact safe account and login final URLs', () => {
        expect(readLoginStatusFromFinalUrl(`https://nid.naver.com${LOGIN_STATUS_LOGIN_PATH}`))
            .toEqual({ status: 'logged_out', evidence: 'redirect_login' });
        expect(readLoginStatusFromFinalUrl(`https://nid.naver.com${LOGIN_STATUS_ACCOUNT_PATH}`))
            .toEqual({ status: 'logged_in', evidence: 'account_page' });
        for (const url of [
            'https://www.naver.com/',
            'https://nid.naver.com/other',
            `http://nid.naver.com${LOGIN_STATUS_ACCOUNT_PATH}`,
            `https://attacker.test@nid.naver.com${LOGIN_STATUS_ACCOUNT_PATH}`,
            `https://nid.naver.com@attacker.test${LOGIN_STATUS_ACCOUNT_PATH}`,
        ]) {
            expect(readLoginStatusFromFinalUrl(url)).toBeNull();
        }
    });

    it('allows only the fixed account and login navigations and same-site redirects temporarily', () => {
        const policy = loginStatusPolicy();
        expect(LOGIN_STATUS_ORIGIN).toBe('https://nid.naver.com');
        expect(LOGIN_STATUS_URL).toBe('https://nid.naver.com/user2/help/myInfo');
        expect(policy.navigationOrigin).toBe(LOGIN_STATUS_ORIGIN);
        expect(policy.navigationPath).toBe(LOGIN_STATUS_ACCOUNT_PATH);
        expect(policy.navigationPaths).toEqual([LOGIN_STATUS_ACCOUNT_PATH, LOGIN_STATUS_LOGIN_PATH]);
        expect(policy.resourceOrigins).toEqual([
            'https://www.naver.com',
            'https://ssl.pstatic.net',
            'https://s.pstatic.net',
        ]);
        expect(classifyLoginStatusRequest(LOGIN_STATUS_URL, 'GET', 'navigation', policy)).toBe('allow');
        expect(classifyLoginStatusRequest(`https://nid.naver.com${LOGIN_STATUS_LOGIN_PATH}`, 'GET', 'navigation', policy)).toBe('allow');
        expect(classifyLoginStatusRequest('https://nid.naver.com/other', 'GET', 'navigation', policy)).toBe('deny-navigation');
        expect(classifyLoginStatusRequest('https://www.naver.com/other', 'GET', 'navigation', policy)).toBe('deny-navigation');
        expect(classifyLoginStatusRequest('https://www.naver.com/redirected/path', 'GET', 'navigation', policy, { redirected: true })).toBe('allow');
        expect(classifyLoginStatusRequest(`https://nid.naver.com${LOGIN_STATUS_LOGIN_PATH}`, 'GET', 'navigation', policy, { redirected: true })).toBe('allow');
        expect(classifyLoginStatusRequest('https://evil.example/resource', 'GET', 'navigation', policy, { redirected: true })).toBe('deny-navigation');
        expect(classifyLoginStatusRequest('http://www.naver.com/', 'GET', 'navigation', policy, { redirected: true })).toBe('deny-navigation');
        expect(classifyLoginStatusRequest('https://attacker.test@nid.naver.com/user2/help/myInfo', 'GET', 'navigation', policy)).toBe('deny-navigation');
        expect(classifyLoginStatusRequest(LOGIN_STATUS_URL, 'POST', 'navigation', policy)).toBe('deny-mutation');
        expect(classifyLoginStatusRequest(LOGIN_STATUS_URL, 'HEAD', 'navigation', policy)).toBe('deny-mutation');
        expect(classifyLoginStatusRequest('https://ssl.pstatic.net/static/naver.css', 'GET', 'resource', policy)).toBe('allow');
        expect(classifyLoginStatusRequest('https://s.pstatic.net/static/naver.png', 'HEAD', 'resource', policy)).toBe('allow');
        expect(classifyLoginStatusRequest('https://evil.example/resource', 'GET', 'resource', policy)).toBe('deny-resource');
        expect(classifyLoginStatusRequest(LOGIN_STATUS_URL, 'GET', 'resource', policy)).toBe('deny-resource');
    });

    it('uses a fake page port to classify the final URL before the link fallback', async () => {
        const makePage = (finalUrl, fallback = { status: 'unknown', evidence: 'none' }, failNavigation = false) => {
            const calls = [];
            return {
                calls,
                currentUrl: finalUrl,
                async goto(url, options) {
                    calls.push({ type: 'goto', url, options });
                    if (failNavigation) throw new Error('redirect blocked');
                },
                url() { return this.currentUrl; },
                async evaluate(fn) {
                    calls.push({ type: 'evaluate', name: fn.name });
                    return fallback;
                },
            };
        };

        const login = makePage(`https://nid.naver.com${LOGIN_STATUS_LOGIN_PATH}`);
        expect(await readLoginStatusFromPage(login)).toEqual({ status: 'logged_out', evidence: 'redirect_login' });
        expect(login.calls).toEqual([{ type: 'goto', url: LOGIN_STATUS_URL, options: { waitUntil: 'domcontentloaded' } }]);

        const account = makePage(LOGIN_STATUS_URL);
        expect(await readLoginStatusFromPage(account)).toEqual({ status: 'logged_in', evidence: 'account_page' });
        expect(account.calls).toHaveLength(1);

        for (const finalUrl of [
            'https://evil.example/redirected',
            `http://nid.naver.com${LOGIN_STATUS_ACCOUNT_PATH}`,
            `https://attacker.test@nid.naver.com${LOGIN_STATUS_ACCOUNT_PATH}`,
        ]) {
            const fallback = makePage(finalUrl, { status: 'unknown', evidence: 'none' });
            expect(await readLoginStatusFromPage(fallback)).toEqual({ status: 'unknown', evidence: 'none' });
            expect(fallback.calls.at(-1)).toEqual({ type: 'evaluate', name: 'readLoginStatusFromDocument' });
        }

        const linkFallback = makePage('https://www.naver.com/', { status: 'logged_out', evidence: 'login_link' }, true);
        expect(await readLoginStatusFromPage(linkFallback)).toEqual({ status: 'logged_out', evidence: 'login_link' });
        expect(linkFallback.calls.map((call) => call.type)).toEqual(['goto', 'evaluate']);

        const failedNavigation = makePage(LOGIN_STATUS_URL, { status: 'unknown', evidence: 'none' }, true);
        expect(await readLoginStatusFromPage(failedNavigation)).toEqual({ status: 'unknown', evidence: 'none' });
    });
});
