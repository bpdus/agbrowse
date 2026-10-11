import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { LOGIN_STATUS_ORIGIN, LOGIN_STATUS_URL, loginStatusPolicy, readLoginStatusFromDocument } from '../../skills/browser/agent-naver-login-status.mjs';
import { classifyRequest, productionSearchPolicy } from '../../skills/browser/agent-naver-search.mjs';

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
            expect(JSON.stringify(result)).not.toMatch(/Fixture Private Name|fixture\.private@example\.test|nidlogin\.(?:login|logout)|url=/i);
        }
    });

    it('allows only the fixed homepage navigation and its static hosts for this operation', () => {
        const policy = loginStatusPolicy();
        expect(LOGIN_STATUS_ORIGIN).toBe('https://www.naver.com');
        expect(LOGIN_STATUS_URL).toBe('https://www.naver.com/');
        expect(policy.navigationOrigin).toBe(LOGIN_STATUS_ORIGIN);
        expect(policy.navigationPath).toBe('/');
        expect(policy.resourceOrigins).toEqual([
            'https://www.naver.com',
            'https://ssl.pstatic.net',
            'https://s.pstatic.net',
        ]);
        expect(classifyRequest(LOGIN_STATUS_URL, 'GET', 'navigation', policy)).toBe('allow');
        expect(classifyRequest('https://www.naver.com/other', 'GET', 'navigation', policy)).toBe('deny-navigation');
        expect(classifyRequest('https://ssl.pstatic.net/static/naver.css', 'GET', 'resource', policy)).toBe('allow');
        expect(classifyRequest('https://s.pstatic.net/static/naver.png', 'GET', 'resource', policy)).toBe('allow');
        expect(classifyRequest('https://nid.naver.com/nidlogin.login', 'GET', 'resource', policy)).toBe('deny-resource');
        expect(classifyRequest('https://evil.example/resource', 'GET', 'resource', policy)).toBe('deny-resource');
        expect(classifyRequest(LOGIN_STATUS_URL, 'POST', 'navigation', policy)).toBe('deny-mutation');
        expect(classifyRequest(LOGIN_STATUS_URL, 'GET', 'resource', productionSearchPolicy())).toBe('deny-resource');
    });
});
