// @ts-check
/**
 * Read-only Naver login-state classifier. The primary signal is the final
 * top-level URL; the fallback reads only fixed authentication link targets.
 */

export const LOGIN_STATUS_ORIGIN = 'https://nid.naver.com';
export const LOGIN_STATUS_ACCOUNT_PATH = '/user2/help/myInfo';
export const LOGIN_STATUS_LOGIN_PATH = '/nidlogin.login';
export const LOGIN_STATUS_URL = `${LOGIN_STATUS_ORIGIN}${LOGIN_STATUS_ACCOUNT_PATH}`;

const LOGIN_STATUS_RESOURCE_ORIGINS = Object.freeze([
    'https://www.naver.com',
    'https://ssl.pstatic.net',
    'https://s.pstatic.net',
]);

/** A per-operation policy. The runtime installs it on one page only temporarily. */
export function loginStatusPolicy() {
    return Object.freeze({
        operation: 'naver.login_status',
        navigationOrigin: LOGIN_STATUS_ORIGIN,
        navigationPath: LOGIN_STATUS_ACCOUNT_PATH,
        navigationPaths: Object.freeze([LOGIN_STATUS_ACCOUNT_PATH, LOGIN_STATUS_LOGIN_PATH]),
        resourceOrigins: LOGIN_STATUS_RESOURCE_ORIGINS,
        harnessOrigin: null,
    });
}

/**
 * Classify one request under the temporary login-status page policy.
 * Redirect destinations and the initial navigation are limited to the exact
 * account and login paths on nid.naver.com.
 * @param {string} rawUrl
 * @param {string} method
 * @param {'navigation' | 'resource'} kind
 * @param {ReturnType<typeof loginStatusPolicy>} policy
 * @param {{ redirected?: boolean }} [options]
 * @returns {'allow' | 'deny-mutation' | 'deny-navigation' | 'deny-resource'}
 */
export function classifyLoginStatusRequest(rawUrl, method, kind, policy = loginStatusPolicy(), options = {}) {
    const upper = String(method || 'GET').toUpperCase();
    if (kind === 'navigation' ? upper !== 'GET' : upper !== 'GET' && upper !== 'HEAD') return 'deny-mutation';

    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return kind === 'navigation' ? 'deny-navigation' : 'deny-resource';
    }
    if (url.username || url.password || url.protocol !== 'https:') {
        return kind === 'navigation' ? 'deny-navigation' : 'deny-resource';
    }

    if (kind === 'navigation') {
        if (options.redirected) {
            return url.origin === policy.navigationOrigin
                && policy.navigationPaths.includes(url.pathname)
                ? 'allow'
                : 'deny-navigation';
        }
        return url.origin === policy.navigationOrigin && policy.navigationPaths.includes(url.pathname)
            ? 'allow'
            : 'deny-navigation';
    }
    return policy.resourceOrigins.includes(url.origin) ? 'allow' : 'deny-resource';
}

/**
 * Return a status only for the two exact final top-level URL signals.
 * The URL is never included in the result.
 * @param {string} rawUrl
 * @returns {{ status: 'logged_in' | 'logged_out', evidence: 'account_page' | 'redirect_login' } | null}
 */
export function readLoginStatusFromFinalUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        if (url.protocol !== 'https:' || url.host !== 'nid.naver.com' || url.username || url.password) return null;
        if (url.pathname === LOGIN_STATUS_LOGIN_PATH) return { status: 'logged_out', evidence: 'redirect_login' };
        if (url.pathname === LOGIN_STATUS_ACCOUNT_PATH) return { status: 'logged_in', evidence: 'account_page' };
        return null;
    } catch {
        return null;
    }
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
                    const url = new URL(value, root.defaultView?.location?.href || LOGIN_STATUS_URL);
                    return url.protocol === 'https:'
                        && !url.username
                        && !url.password
                        && url.host === 'nid.naver.com'
                        && url.pathname === pathname;
                } catch {
                    return false;
                }
            });
        });

        if (hasAuthTarget('/nidlogin.logout')) return { status: 'logged_in', evidence: 'logout_link' };
        if (hasAuthTarget(LOGIN_STATUS_LOGIN_PATH)) return { status: 'logged_out', evidence: 'login_link' };
        return { status: 'unknown', evidence: 'none' };
    } catch {
        return { status: 'unknown', evidence: 'none' };
    }
}

/**
 * Navigate through a page-like port, inspect only its final URL first, then
 * fall back to the existing link-only document check when that URL is unknown.
 * @param {{ goto?: (url: string, options?: { waitUntil?: string }) => Promise<unknown>, url?: () => string, evaluate?: (fn: (doc?: ParentNode) => unknown) => Promise<unknown> }} page
 * @param {{ getValidatedFinalUrl?: () => string | null, requireValidatedFinalUrl?: boolean }} [options]
 */
export async function readLoginStatusFromPage(page, options = {}) {
    let navigationSucceeded = false;
    if (typeof page?.goto === 'function') {
        try {
            await page.goto(LOGIN_STATUS_URL, { waitUntil: 'domcontentloaded' });
            navigationSucceeded = true;
        } catch {
            // A blocked redirect can reject navigation while leaving the current document readable.
        }
    }

    const validatedFinalUrl = typeof options.getValidatedFinalUrl === 'function'
        ? options.getValidatedFinalUrl()
        : null;
    if (options.requireValidatedFinalUrl && !validatedFinalUrl) {
        return { status: 'unknown', evidence: 'none' };
    }

    const primary = navigationSucceeded
        ? readLoginStatusFromFinalUrl(options.requireValidatedFinalUrl
            ? validatedFinalUrl
            : (typeof page?.url === 'function' ? page.url() : ''))
        : null;
    if (primary) return primary;

    if (typeof page?.evaluate !== 'function') return { status: 'unknown', evidence: 'none' };
    const value = await page.evaluate(readLoginStatusFromDocument);
    if (value && typeof value === 'object') {
        const result = /** @type {{ status?: unknown, evidence?: unknown }} */ (value);
        if (result.status === 'logged_in' && result.evidence === 'logout_link') {
            return { status: 'logged_in', evidence: 'logout_link' };
        }
        if (result.status === 'logged_out' && result.evidence === 'login_link') {
            return { status: 'logged_out', evidence: 'login_link' };
        }
    }
    return { status: 'unknown', evidence: 'none' };
}
