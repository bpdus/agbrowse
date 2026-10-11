// @ts-check
/**
 * Read-only login-state classifier for the Naver homepage. It reads only
 * visible top-bar control destinations and account markers, never page text.
 */

export const LOGIN_STATUS_ORIGIN = 'https://www.naver.com';
export const LOGIN_STATUS_URL = `${LOGIN_STATUS_ORIGIN}/`;

const LOGIN_STATUS_STATIC_ORIGINS = Object.freeze([
    'https://ssl.pstatic.net',
    'https://s.pstatic.net',
]);

/** A per-operation policy. The runtime installs it on one page only temporarily. */
export function loginStatusPolicy() {
    return Object.freeze({
        navigationOrigin: LOGIN_STATUS_ORIGIN,
        navigationPath: '/',
        resourceOrigins: [LOGIN_STATUS_ORIGIN, ...LOGIN_STATUS_STATIC_ORIGINS],
        harnessOrigin: null,
    });
}

/**
 * Runs in Node against a document, or in the page with no arguments.
 * The returned object has a closed vocabulary and never contains DOM values.
 * @param {ParentNode | undefined} doc
 */
export function readLoginStatusFromDocument(doc) {
    try {
        const root = doc && typeof doc.querySelectorAll === 'function' ? doc : globalThis.document;
        if (!root || typeof root.querySelectorAll !== 'function') return { status: 'unknown', evidence: 'none' };

        const topBars = [...root.querySelectorAll(
            'header, [role="banner"], #header, #gnb, #account, [data-testid*="topbar" i], [class*="topbar" i]',
        )];
        if (topBars.length === 0) return { status: 'unknown', evidence: 'none' };

        const visible = (element) => {
            if (element.hidden || element.closest('[hidden], [aria-hidden="true"]')) return false;
            const view = root.defaultView || root.ownerDocument?.defaultView || globalThis;
            if (typeof view.getComputedStyle === 'function') {
                const style = view.getComputedStyle(element);
                if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
            }
            return typeof element.getClientRects === 'function' && element.getClientRects().length > 0;
        };

        const controls = topBars.flatMap((topBar) => [
            ...topBar.querySelectorAll('a[href], button[href], button[formaction], button[data-href], button[data-url]'),
        ]);
        const destination = (control) => {
            for (const attribute of ['href', 'formaction', 'data-href', 'data-url']) {
                const value = control.getAttribute(attribute);
                if (value) {
                    try { return new URL(value, root.defaultView?.location?.href || 'https://www.naver.com/'); } catch { /* try next attribute */ }
                }
            }
            return null;
        };
        const loginLink = controls.some((control) => {
            if (!visible(control)) return false;
            const url = destination(control);
            return url?.protocol === 'https:' && url.hostname === 'nid.naver.com'
                && /^\/nidlogin(?:[./_-]|$)/i.test(url.pathname);
        });
        if (loginLink) return { status: 'logged_out', evidence: 'login_link' };

        const logoutControl = controls.some((control) => {
            if (!visible(control)) return false;
            const url = destination(control);
            if (url?.protocol === 'https:' && url.hostname === 'nid.naver.com'
                && /(?:^|\/)(?:nidlogin\.logout|logout)(?:[./_-]|$)/i.test(url.pathname)) return true;
            const accessibleName = `${control.getAttribute('aria-label') || ''} ${control.getAttribute('title') || ''}`;
            return /(?:log\s*out|logout|로그아웃)/i.test(accessibleName);
        });
        if (logoutControl) return { status: 'logged_in', evidence: 'logout_control' };

        const accountMarkers = topBars.flatMap((topBar) => [
            ...topBar.querySelectorAll(
                '[data-testid*="account-menu" i], [data-testid*="user-menu" i], '
                + '[aria-label*="계정" i], [aria-label*="프로필" i], [aria-label*="사용자 메뉴" i], '
                + '[class*="my_info" i], [class*="user_menu" i], [class*="account_menu" i]',
            ),
        ]);
        if (accountMarkers.some(visible)) return { status: 'logged_in', evidence: 'account_menu' };
        return { status: 'unknown', evidence: 'none' };
    } catch {
        return { status: 'unknown', evidence: 'none' };
    }
}
