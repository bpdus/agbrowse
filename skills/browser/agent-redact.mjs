// @ts-check
/**
 * Output-boundary redaction. Logs and responses must not carry secrets.
 */

const SECRET_ASSIGNMENT = /(?:bearer\s+[a-z0-9._~+/=-]{8,}|eyJ[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}|(?:password|passwd|secret|token|otp|cookie|authorization|api[_-]?key)\s*[:=]\s*\S+|(?:password|passwd|secret|token|otp)[-_][a-z0-9_-]{5,})/gi;
const SECRET_QUERY_NAME = /^(?:access_token|api_key|auth|cookie|id_token|key|otp|passwd|password|refresh_token|secret|session|token)$/i;

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function redactText(value, max = 240) {
    if (typeof value !== 'string') return '';
    const cleaned = value.replace(SECRET_ASSIGNMENT, '[redacted]').replace(/\s+/g, ' ').trim();
    if (cleaned.length <= max) return cleaned;
    return cleaned.slice(0, max);
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
export function redactValue(value) {
    if (typeof value === 'string') return redactText(value, 2000);
    if (Array.isArray(value)) return value.map((item) => redactValue(item));
    if (value && typeof value === 'object') {
        /** @type {Record<string, unknown>} */
        const out = {};
        for (const [key, item] of Object.entries(value)) out[key] = redactValue(item);
        return out;
    }
    return value;
}

/**
 * @param {string} hostname
 * @returns {boolean}
 */
export function isPrivateHostname(hostname) {
    const host = String(hostname || '').replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
    if (host === 'metadata.google.internal' || host === '0.0.0.0' || host === '::' || host === '::1') return true;
    const dotted = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (dotted) {
        const parts = dotted.slice(1).map((part) => Number(part));
        if (parts.some((part) => part > 255)) return true;
        const [a, b] = parts;
        if (a === 0 || a === 10 || a === 127) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 100 && b >= 64 && b <= 127) return true;
        return false;
    }
    if (host.includes(':')) {
        if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) {
            return true;
        }
    }
    return false;
}

/**
 * @param {unknown} value
 * @param {{ harnessOrigin?: string | null }} [policy]
 * @returns {string | null}
 */
export function sanitizeDestinationUrl(value, policy = {}) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
    let url;
    try {
        url = new URL(value);
    } catch {
        return null;
    }
    if (url.username || url.password || url.protocol === 'javascript:' || url.protocol === 'data:') return null;
    const harness = policy.harnessOrigin && url.origin === policy.harnessOrigin;
    if (url.protocol !== 'https:' && !harness) return null;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!harness && isPrivateHostname(url.hostname)) return null;
    url.hash = '';
    url.username = '';
    url.password = '';
    const kept = new URLSearchParams();
    for (const [key, item] of url.searchParams) {
        SECRET_ASSIGNMENT.lastIndex = 0;
        if (SECRET_QUERY_NAME.test(key)) continue;
        SECRET_ASSIGNMENT.lastIndex = 0;
        if (SECRET_ASSIGNMENT.test(item)) continue;
        kept.append(key, item);
    }
    url.search = kept.size > 0 ? `?${kept.toString()}` : '';
    return url.toString();
}
