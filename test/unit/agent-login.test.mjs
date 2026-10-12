import { describe, expect, it } from 'vitest';
import { assertLoginNavigation, classifyLoginRequest, isLogoutUrl } from '../../skills/browser/agent-login.mjs';

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
    it('restricts top-level navigation to the login page', () => {
        expect(assertLoginNavigation('https://nid.naver.com/nidlogin.login')).toBe('https://nid.naver.com/nidlogin.login');
        expect(() => assertLoginNavigation('https://nid.naver.com/nidlogin.logout')).toThrow();
        expect(() => assertLoginNavigation('https://naver.com/')).toThrow();
    });
});
