// @ts-check
/**
 * Anonymous Naver web-search listing adapter.
 * Navigation is one GET to the fixed search endpoint. No clicks, typing,
 * form submission, shopping, pagination, login, or destination opens.
 * No stealth, fingerprint spoofing, or CAPTCHA solving.
 */

import { readError } from './agent-read-error.mjs';
import { isPrivateHostname, redactText, sanitizeDestinationUrl } from './agent-redact.mjs';

export const NAVIGATION_ORIGIN = 'https://search.naver.com';
export const NAVIGATION_PATH = '/search.naver';
export const RESOURCE_ORIGINS = Object.freeze([
    'https://search.naver.com',
    'https://ssl.pstatic.net',
    'https://s.pstatic.net',
]);

/**
 * @param {{ harnessOrigin?: string | null }} [options]
 */
export function createSearchPolicy(options = {}) {
    /** @type {{ navigationOrigin: string, navigationPath: string, resourceOrigins: string[], harnessOrigin: string | null }} */
    const policy = {
        navigationOrigin: NAVIGATION_ORIGIN,
        navigationPath: NAVIGATION_PATH,
        resourceOrigins: RESOURCE_ORIGINS.slice(),
        harnessOrigin: null,
    };
    if (options.harnessOrigin) {
        let url;
        try {
            url = new URL(options.harnessOrigin);
        } catch {
            throw readError('DOMAIN_DENIED');
        }
        if (url.protocol !== 'http:' || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') || !url.port) {
            throw readError('DOMAIN_DENIED');
        }
        if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
            throw readError('DOMAIN_DENIED');
        }
        policy.navigationOrigin = url.origin;
        policy.harnessOrigin = url.origin;
        policy.resourceOrigins = [url.origin];
    }
    return Object.freeze(policy);
}

export function productionSearchPolicy() {
    return createSearchPolicy();
}

/**
 * @param {string} rawUrl
 * @param {string} method
 * @param {'navigation' | 'resource'} kind
 * @param {{ navigationOrigin: string, navigationPath: string, resourceOrigins: string[], harnessOrigin: string | null }} policy
 * @returns {'allow' | 'deny-mutation' | 'deny-private' | 'deny-navigation' | 'deny-resource'}
 */
export function classifyRequest(rawUrl, method, kind, policy) {
    const upper = String(method || 'GET').toUpperCase();
    if (upper !== 'GET' && upper !== 'HEAD') return 'deny-mutation';
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return 'deny-navigation';
    }
    if (url.username || url.password) return 'deny-navigation';
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'deny-navigation';
    const harness = Boolean(policy.harnessOrigin && url.origin === policy.harnessOrigin);
    if (!harness && isPrivateHostname(url.hostname)) return 'deny-private';
    if (kind === 'navigation') {
        if (url.origin !== policy.navigationOrigin || url.pathname !== policy.navigationPath) return 'deny-navigation';
        return 'allow';
    }
    if (!policy.resourceOrigins.includes(url.origin)) return 'deny-resource';
    return 'allow';
}

/**
 * @param {unknown} query
 * @param {{ navigationOrigin: string, navigationPath: string }} policy
 */
export function buildSearchUrl(query, policy) {
    if (typeof query !== 'string') throw readError('INVALID_ARGUMENTS');
    const text = query.normalize('NFKC').trim();
    if (text.length < 1 || text.length > 80) throw readError('INVALID_ARGUMENTS');
    if (/[\u0000-\u001f\u007f<>"'`\\]/.test(text)) throw readError('INVALID_ARGUMENTS');
    const url = new URL(policy.navigationPath, policy.navigationOrigin);
    url.searchParams.set('where', 'web');
    url.searchParams.set('query', text);
    return url.toString();
}

/**
 * Runs in Node against a document, or inside the page with no arguments.
 * Reads only recognized listing fields. Does not read input values.
 * @param {ParentNode | undefined} doc
 */
export function readListingFromDocument(doc) {
    const root = doc && typeof doc.querySelectorAll === 'function' ? doc : globalThis.document;
    const blocked = root.querySelector('input[type="password"], input[name="otp"], input[autocomplete="one-time-code"], #captcha, .captcha, [data-captcha], [data-agent-block]');
    if (blocked) return { blocked: true, reason: 'HUMAN_REQUIRED', results: [] };
    const containers = [...root.querySelectorAll('.total_wrap, li.bx')];
    if (containers.length === 0) return { blocked: false, reason: 'SITE_UNSUPPORTED', results: [] };
    /** @type {Array<{ rank: number, title: string, snippet: string, href: string }>} */
    const results = [];
    for (const container of containers) {
        const link = container.querySelector('a.link_tit');
        if (!link) continue;
        const title = (link.textContent || '').replace(/\s+/g, ' ').trim();
        const href = link.getAttribute('href') || '';
        const snippetNode = container.querySelector('.total_dsc, .api_txt_lines');
        const snippet = snippetNode ? (snippetNode.textContent || '').replace(/\s+/g, ' ').trim() : '';
        if (!title || !href) continue;
        results.push({ rank: results.length + 1, title, snippet, href });
    }
    if (results.length === 0) return { blocked: false, reason: 'SITE_UNSUPPORTED', results: [] };
    return { blocked: false, reason: null, results };
}

/**
 * @param {string} finalUrl
 * @param {string} title
 * @param {{ navigationOrigin: string }} policy
 */
function publicPage(finalUrl, title, policy) {
    const url = new URL(finalUrl);
    return {
        origin: url.origin,
        url: `${url.origin}${url.pathname}`,
        title: redactText(title, 120),
        harness: url.origin === policy.navigationOrigin,
    };
}

/**
 * @param {Array<{ rank: number, title: string, snippet: string, href: string }>} results
 * @param {string} pageUrl
 * @param {{ harnessOrigin: string | null }} policy
 */
export function publishResults(results, pageUrl, policy) {
    /** @type {Array<{ rank: number, title: string, snippet: string, url: string }>} */
    const published = [];
    for (const item of results) {
        let absolute = item.href;
        try {
            absolute = new URL(item.href, pageUrl).toString();
        } catch {
            continue;
        }
        const url = sanitizeDestinationUrl(absolute, policy);
        if (!url) continue;
        published.push({
            rank: published.length + 1,
            title: redactText(item.title, 180),
            snippet: redactText(item.snippet, 240),
            url,
        });
    }
    return published;
}

/**
 * @param {{ applyPolicy: (policy: any) => Promise<void>, goto: (url: string) => Promise<{ finalUrl: string }>, inspect: () => Promise<any> }} page
 * @param {{ query: string, policy: any, maxNodes?: number }} input
 */
export async function runListing(page, input) {
    const policy = input.policy;
    const url = buildSearchUrl(input.query, policy);
    await page.applyPolicy(policy);
    const nav = await page.goto(url);
    if (classifyRequest(nav.finalUrl, 'GET', 'navigation', policy) !== 'allow') throw readError('DOMAIN_DENIED');
    const inspected = await page.inspect();
    if (inspected.blocked || inspected.reason === 'HUMAN_REQUIRED') throw readError('HUMAN_REQUIRED');
    const results = publishResults(inspected.results || [], nav.finalUrl, policy);
    if (inspected.reason === 'SITE_UNSUPPORTED' || results.length === 0) throw readError('SITE_UNSUPPORTED');
    const pageInfo = publicPage(nav.finalUrl, inspected.title || '', policy);
    delete pageInfo.harness;
    return {
        results,
        page: pageInfo,
        document_epoch: inspected.epoch,
    };
}

/**
 * @param {{ inspect: () => Promise<any>, url?: () => string }} page
 */
export async function runObserve(page, policy) {
    const inspected = await page.inspect();
    if (inspected.blocked || inspected.reason === 'HUMAN_REQUIRED') throw readError('HUMAN_REQUIRED');
    const finalUrl = inspected.finalUrl || (typeof page.url === 'function' ? page.url() : '');
    if (finalUrl && classifyRequest(finalUrl, 'GET', 'navigation', policy) !== 'allow') throw readError('DOMAIN_DENIED');
    const results = publishResults(inspected.results || [], finalUrl || policy.navigationOrigin, policy);
    const pageInfo = finalUrl
        ? publicPage(finalUrl, inspected.title || '', policy)
        : { origin: policy.navigationOrigin, url: `${policy.navigationOrigin}${policy.navigationPath}`, title: '' };
    delete pageInfo.harness;
    return {
        results,
        page: pageInfo,
        document_epoch: inspected.epoch,
    };
}
