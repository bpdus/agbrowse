// @ts-check
/**
 * Read-only login-state classifier for the Naver homepage. It reads only
 * fixed Naver authentication link destinations, never page text.
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

        const targets = [...root.querySelectorAll('a[href], [data-href], [formaction]')];
        const hasAuthTarget = (pathname) => targets.some((element) => {
            const attributes = ['href', 'data-href', 'formaction'];
            return attributes.some((attribute) => {
                if (attribute === 'href' && element.localName !== 'a') return false;
                const value = element.getAttribute(attribute);
                if (!value) return false;
                try {
                    const url = new URL(value, root.defaultView?.location?.href || 'https://www.naver.com/');
                    return url.host === 'nid.naver.com' && url.pathname === pathname;
                } catch {
                    return false;
                }
            });
        });

        if (hasAuthTarget('/nidlogin.logout')) return { status: 'logged_in', evidence: 'logout_link' };
        if (hasAuthTarget('/nidlogin.login')) return { status: 'logged_out', evidence: 'login_link' };
        return { status: 'unknown', evidence: 'none' };
    } catch {
        return { status: 'unknown', evidence: 'none' };
    }
}
