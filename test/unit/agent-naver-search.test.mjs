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
const modernListingPath = fileURLToPath(new URL('../fixtures/agent-read/naver-web-2026-10.html', import.meta.url));
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

    it('reads one modern web result per document root from headline anchors', () => {
        const doc = documentFrom(modernListingPath);
        const roots = [...doc.querySelectorAll('[data-meta-area="web_lis"] .fds-web-doc-root')];
        const headlineSelector = 'a[data-heatmap-target=".link"] span.sds-comps-text-type-headline1';
        const expectedTitles = roots.map((root) => (root.querySelector(headlineSelector)?.textContent || '').replace(/\s+/g, ' ').trim());
        const profileAnchor = doc.querySelector('.sds-comps-profile')?.closest('a');
        const keepAnchor = [...doc.querySelectorAll('a')].find((anchor) => (anchor.textContent || '').includes('Keep에 저장'));
        const imageAnchor = doc.querySelector('a[data-heatmap-target=".simg"]');
        const first = readListingFromDocument(doc);
        const second = readListingFromDocument(doc);

        expect(first).toMatchObject({ blocked: false, reason: null });
        expect(first.results).toHaveLength(5);
        expect(profileAnchor).not.toBeNull();
        expect(keepAnchor).toBeDefined();
        expect(imageAnchor).not.toBeNull();
        expect(first.results.map((item) => item.rank)).toEqual([1, 2, 3, 4, 5]);
        expect(first.results.slice(0, 2).map(({ title, href }) => ({ title, href }))).toEqual([
            { title: '육성돈', href: 'https://happyto.nonghyup.com/happyto/95172/subview.do' },
            { title: '자돈', href: 'https://happyto.nonghyup.com/happyto/95171/subview.do' },
        ]);
        expect(first.results.map((item) => item.title)).toEqual(expectedTitles);

        expect(first.results[0].snippet).toBe([
            '특징:',
            '1. 성장 단계별에 따른 영양소 공급을 위한 배합 설계로 뛰어난 증체량과 높은 사료효율',
            '2. 돈사 및 분변내 가스 및 악취 발생 감소를 위한 한국실정에 맞는 미생물 제제 첨가',
            '3. 동충하초 첨가로 돼지의 대사 활력 증가 및 면역력 강화',
        ].join(' '));
        expect(first.results[1].snippet).toContain('1. 기호성과 용해도가 높은 특수원료 사용 2. 물에 녹았을때 침전물이 거의 생기지 안아 급이가 용이함');
        expect(first.results[4].snippet).toContain('2026.07.09.');
        expect(first.results[4].snippet).toContain('연구진은 이러한 결과로');
        expect(first.results[4].snippet.match(/2026\.07\.09\./g)).toHaveLength(1);

        const titleAnchorHrefs = roots.map((root) => root.querySelector(headlineSelector)?.closest('a')?.getAttribute('href'));
        expect(first.results.map((item) => item.href)).toEqual(titleAnchorHrefs);
        expect(second.results.map((item) => item.node_id)).toEqual(first.results.map((item) => item.node_id));
        expect(first.results.every((item) => /^n_[a-f0-9]{1,32}$/.test(item.node_id))).toBe(true);
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

    it('assigns a new node id when the same listing text is a new element', () => {
        const dom = new JSDOM(readFileSync(listingPath, 'utf8'));
        const first = readListingFromDocument(dom.window.document);
        const link = dom.window.document.querySelector('a.link_tit');
        link.replaceWith(link.cloneNode(true));
        const second = readListingFromDocument(dom.window.document);
        expect(second.results[0].title).toBe(first.results[0].title);
        expect(second.results[0].href).toBe(first.results[0].href);
        expect(first.results[0].node_id).toMatch(/^n_[a-f0-9]{1,32}$/);
        expect(second.results[0].node_id).toMatch(/^n_[a-f0-9]{1,32}$/);
        expect(second.results[0].node_id).not.toBe(first.results[0].node_id);
        expect(second.results[1].node_id).toBe(first.results[1].node_id);
        const published = publishResults(second.results, 'https://search.naver.com/search.naver', productionSearchPolicy());
        expect(published[0].node_id).toBe(second.results[0].node_id);
        expect(published[1].node_id).toBe(second.results[1].node_id);
    });
});
