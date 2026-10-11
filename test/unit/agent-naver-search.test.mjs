import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import {
    buildSearchUrl,
    classifyRequest,
    createSearchPolicy,
    productionSearchPolicy,
    publishResults,
    readListingFromDocument,
    runListing,
    runObserve,
} from '../../skills/browser/agent-naver-search.mjs';
import { createFakePage, startFixtureServer } from '../helpers/agent-fake-page.mjs';

const listingPath = fileURLToPath(new URL('../fixtures/agent-read/listing.html', import.meta.url));
const blockPath = fileURLToPath(new URL('../fixtures/agent-read/block.html', import.meta.url));
const unknownPath = fileURLToPath(new URL('../fixtures/agent-read/unknown.html', import.meta.url));
const source = readFileSync(new URL('../../skills/browser/agent-naver-search.mjs', import.meta.url), 'utf8');
const servers = [];

afterEach(async () => {
    while (servers.length > 0) await servers.pop().close();
});

function documentFrom(path) {
    return new JSDOM(readFileSync(path, 'utf8')).window.document;
}

describe('naver search adapter', () => {
    it('reads only listing fields from the fixture pages', () => {
        const listing = readListingFromDocument(documentFrom(listingPath));
        expect(listing.blocked).toBe(false);
        expect(listing.results.map((item) => item.rank)).toEqual([1, 2]);
        expect(listing.results[0].href).toContain('token=canary-token-value');
        expect(JSON.stringify(listing.results)).not.toContain('canary-secret-value');
        expect(listing.results.some((item) => item.title === 'read')).toBe(false);

        const published = publishResults(listing.results, 'https://search.naver.com/search.naver', productionSearchPolicy());
        expect(published[0].url).toBe('https://news.example/a?ok=1');
        expect(JSON.stringify(published)).not.toMatch(/canary-password-value|canary-token-value|canary-otp-value|canary-secret-value/);

        const blocked = readListingFromDocument(documentFrom(blockPath));
        expect(blocked).toMatchObject({ blocked: true, reason: 'HUMAN_REQUIRED', results: [] });
        expect(JSON.stringify(blocked)).not.toMatch(/canary-password-value|canary-secret-value/);

        const unknown = readListingFromDocument(documentFrom(unknownPath));
        expect(unknown).toMatchObject({ blocked: false, reason: 'SITE_UNSUPPORTED', results: [] });
    });

    it('allows only the fixed search navigation and blocks mutation or private targets', () => {
        const policy = productionSearchPolicy();
        expect(policy.harnessOrigin).toBeNull();
        expect(policy.navigationOrigin).toBe('https://search.naver.com');
        expect(classifyRequest('https://search.naver.com/search.naver?where=web&query=widgets', 'GET', 'navigation', policy)).toBe('allow');
        expect(classifyRequest('https://ssl.pstatic.net/img', 'GET', 'resource', policy)).toBe('allow');
        expect(classifyRequest('https://search.naver.com/search.naver', 'POST', 'navigation', policy)).toBe('deny-mutation');
        expect(classifyRequest('https://169.254.169.254/latest', 'GET', 'navigation', policy)).toBe('deny-private');
        expect(classifyRequest('https://evil.example/search.naver', 'GET', 'navigation', policy)).toBe('deny-navigation');
        expect(classifyRequest('javascript:alert(1)', 'GET', 'navigation', policy)).toBe('deny-navigation');
        expect(() => createSearchPolicy({ harnessOrigin: 'https://evil.example' })).toThrow(expect.objectContaining({ code: 'DOMAIN_DENIED' }));
        expect(() => createSearchPolicy({ harnessOrigin: 'http://127.0.0.1/search' })).toThrow(expect.objectContaining({ code: 'DOMAIN_DENIED' }));

        const harness = createSearchPolicy({ harnessOrigin: 'http://127.0.0.1:9' });
        expect(classifyRequest('http://127.0.0.1:9/search.naver?where=web&query=widgets', 'GET', 'navigation', harness)).toBe('allow');
        expect(classifyRequest('https://ssl.pstatic.net/img', 'GET', 'resource', harness)).toBe('deny-resource');
        expect(buildSearchUrl('  widgets  ', policy)).toBe('https://search.naver.com/search.naver?where=web&query=widgets');
        expect(() => buildSearchUrl('bad<query>', policy)).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENTS' }));
        expect(source).not.toMatch(/\.click\(|\.fill\(|\.press\(|\.type\(|setInputFiles/);
    });

    it('lists a loopback fixture without mutations, popups, or secret fields', async () => {
        const fixture = await startFixtureServer();
        servers.push(fixture);
        const policy = createSearchPolicy({ harnessOrigin: fixture.origin });
        const page = createFakePage();
        const listed = await runListing(page, { query: 'widgets', policy, maxNodes: 20 });
        expect(listed.page.origin).toBe(fixture.origin);
        expect(listed.page.url).toBe(`${fixture.origin}/search.naver`);
        expect(listed.results[0].url).toBe('https://news.example/a?ok=1');
        expect(listed.results[1].title).toBe('Beta');
        expect(JSON.stringify(listed)).not.toMatch(/canary-password-value|canary-token-value|canary-otp-value|canary-secret-value|widgets/);
        expect(page.calls).toEqual(['applyPolicy', 'goto', 'inspect']);
        expect(page.fetched.every((url) => new URL(url).hostname === '127.0.0.1')).toBe(true);
        expect(fixture.counts()).toEqual({ mutations: 0, popupFetches: 0 });

        page.replace('<html><head><title>SubstitutedTitle</title></head><body><div class="total_wrap"><a class="link_tit" href="https://news.example/z">SubstitutedTitle</a><div class="total_dsc">changed</div></div></body></html>');
        const observed = await runObserve(page, policy);
        expect(observed.document_epoch).toBeGreaterThan(listed.document_epoch);
        expect(observed.results[0].title).toBe('SubstitutedTitle');

        await page.applyPolicy(policy);
        const denied = await page.goto(`${fixture.origin}/search.naver?where=web&query=canary-secret-value&hop=private`).catch((error) => error);
        expect(denied).toMatchObject({ code: 'DOMAIN_DENIED', message: 'The destination is not permitted.' });
        expect(`${denied.message}\n${denied.stack}`).not.toMatch(/canary-secret-value|169\.254\.169\.254/);
        expect(page.fetched.some((url) => url.includes('169.254.169.254'))).toBe(false);
        expect(fixture.counts()).toEqual({ mutations: 0, popupFetches: 0 });

        const blockedPage = createFakePage();
        await blockedPage.applyPolicy(policy);
        await blockedPage.goto(`${fixture.origin}/search.naver?screen=block`);
        const blocked = await runObserve(blockedPage, policy).catch((error) => error);
        expect(blocked).toMatchObject({ code: 'HUMAN_REQUIRED', message: 'A person must continue.' });
        expect(`${blocked.message}\n${blocked.stack}`).not.toMatch(/canary-password-value|canary-secret-value/);

        const unknownPage = createFakePage();
        await unknownPage.applyPolicy(policy);
        await unknownPage.goto(`${fixture.origin}/search.naver?screen=unknown`);
        await expect(runObserve(unknownPage, policy)).rejects.toMatchObject({ code: 'SITE_UNSUPPORTED' });
        expect(fixture.counts()).toEqual({ mutations: 0, popupFetches: 0 });
    });
});
