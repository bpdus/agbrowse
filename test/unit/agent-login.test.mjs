import { describe, expect, it } from 'vitest';
import { assertLoginNavigation, classifyLoginRequest, isLogoutUrl, waitForProfileRelease } from '../../skills/browser/agent-login.mjs';

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
        const fakeFs = { lstatSync() { lockCalls += 1; if (lockCalls === 1) return {}; const error = new Error(); error.code = 'ENOENT'; throw error; } };
        await waitForProfileRelease('/profile', { fs: fakeFs, intervalMs: 1, timeoutMs: 20 });
        expect(lockCalls).toBeGreaterThan(3);
        const lockedFs = { lstatSync() { return {}; } };
        await expect(waitForProfileRelease('/profile', { fs: lockedFs, intervalMs: 1, timeoutMs: 4 })).rejects.toMatchObject({ code: 'PROFILE_RELEASE_TIMEOUT' });
    });

    it('restricts top-level navigation to the login page', () => {
        expect(assertLoginNavigation('https://nid.naver.com/nidlogin.login')).toBe('https://nid.naver.com/nidlogin.login');
        expect(() => assertLoginNavigation('https://nid.naver.com/nidlogin.logout')).toThrow();
        expect(() => assertLoginNavigation('https://naver.com/')).toThrow();
        expect(() => assertLoginNavigation('https://user:pass@nid.naver.com/nidlogin.login')).toThrow();
    });
});
