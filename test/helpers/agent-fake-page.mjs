import * as http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { readError } from '../../skills/browser/agent-read-error.mjs';
import { classifyRequest, readListingFromDocument } from '../../skills/browser/agent-naver-search.mjs';

const listingHtml = readFileSync(new URL('../fixtures/agent-read/listing.html', import.meta.url), 'utf8');
const blockHtml = readFileSync(new URL('../fixtures/agent-read/block.html', import.meta.url), 'utf8');
const unknownHtml = readFileSync(new URL('../fixtures/agent-read/unknown.html', import.meta.url), 'utf8');

/**
 * @param {URL} target
 */
function getOnce(target) {
    return new Promise((resolve, reject) => {
        const req = http.get(target, (res) => {
            /** @type {Buffer[]} */
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode || 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('error', () => reject(readError('INTERNAL')));
    });
}

export function startFixtureServer() {
    let mutations = 0;
    let popupFetches = 0;
    const server = http.createServer((req, res) => {
        const method = req.method || 'GET';
        if (method !== 'GET' && method !== 'HEAD') {
            mutations += 1;
            res.writeHead(405);
            res.end();
            return;
        }
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (url.pathname === '/popup') {
            popupFetches += 1;
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('popup');
            return;
        }
        if (url.pathname === '/search.naver' && url.searchParams.get('hop') === 'private') {
            res.writeHead(302, { location: 'http://169.254.169.254/latest' });
            res.end();
            return;
        }
        if (url.pathname === '/search.naver' && url.searchParams.get('hop') === 'local') {
            res.writeHead(302, { location: '/search.naver' });
            res.end();
            return;
        }
        if (url.pathname === '/search.naver' && url.searchParams.get('screen') === 'block') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(blockHtml);
            return;
        }
        if (url.pathname === '/search.naver' && url.searchParams.get('screen') === 'unknown') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(unknownHtml);
            return;
        }
        if (url.pathname === '/search.naver') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(listingHtml);
            return;
        }
        res.writeHead(404);
        res.end();
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (!address || typeof address === 'string') throw new Error('fixture bind failed');
            resolve({
                origin: `http://127.0.0.1:${address.port}`,
                counts: () => ({ mutations, popupFetches }),
                close: () => new Promise((done) => server.close(() => done(undefined))),
            });
        });
    });
}

export function createFakePage() {
    let html = '';
    let currentUrl = 'about:blank';
    let epoch = 1;
    /** @type {any} */
    let policy = null;
    /** @type {string[]} */
    const calls = [];
    /** @type {string[]} */
    const fetched = [];
    return {
        calls,
        fetched,
        epoch: () => epoch,
        html: () => html,
        /**
         * @param {string} next
         */
        replace(next) {
            html = next;
            epoch += 1;
        },
        /**
         * @param {any} next
         */
        async applyPolicy(next) {
            calls.push('applyPolicy');
            policy = next;
        },
        /**
         * @param {string} url
         */
        async goto(url) {
            calls.push('goto');
            if (!policy || classifyRequest(url, 'GET', 'navigation', policy) !== 'allow') throw readError('DOMAIN_DENIED');
            const target = new URL(url);
            if (target.hostname !== '127.0.0.1') throw readError('DOMAIN_DENIED');
            fetched.push(target.toString());
            const first = await getOnce(target);
            let finalUrl = target.toString();
            let body = first.body;
            if (first.status >= 300 && first.status < 400) {
                const location = first.headers.location;
                if (typeof location !== 'string') throw readError('DOMAIN_DENIED');
                const next = new URL(location, target);
                if (classifyRequest(next.toString(), 'GET', 'navigation', policy) !== 'allow') throw readError('DOMAIN_DENIED');
                if (next.hostname !== '127.0.0.1') throw readError('DOMAIN_DENIED');
                fetched.push(next.toString());
                const second = await getOnce(next);
                body = second.body;
                finalUrl = next.toString();
            }
            html = body;
            currentUrl = finalUrl;
            epoch += 1;
            return { finalUrl };
        },
        async inspect() {
            calls.push('inspect');
            const dom = new JSDOM(html, { url: currentUrl.startsWith('http') ? currentUrl : 'http://127.0.0.1/' });
            const extracted = readListingFromDocument(dom.window.document);
            return {
                blocked: extracted.blocked,
                reason: extracted.reason,
                results: extracted.results,
                title: dom.window.document.title,
                finalUrl: currentUrl,
                epoch,
            };
        },
        url() {
            return currentUrl;
        },
        click() {
            calls.push('click');
            throw new Error('click');
        },
        fill() {
            calls.push('fill');
            throw new Error('fill');
        },
        press() {
            calls.push('press');
            throw new Error('press');
        },
        type() {
            calls.push('type');
            throw new Error('type');
        },
    };
}

export const fixturePaths = {
    listing: fileURLToPath(new URL('../fixtures/agent-read/listing.html', import.meta.url)),
    block: fileURLToPath(new URL('../fixtures/agent-read/block.html', import.meta.url)),
    unknown: fileURLToPath(new URL('../fixtures/agent-read/unknown.html', import.meta.url)),
};
