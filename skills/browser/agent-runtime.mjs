// @ts-check
/**
 * Opt-in local Chrome runtime for one dedicated profile.
 * Playwright objects, CDP sessions, and the lock token stay inside this module.
 * Session lookup uses only the instance map and never the active or last tab.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { acquireProfileLock, releaseProfileLock } from './profile-lock.mjs';
import { AgentReadError, READ_ERROR_MESSAGES, readError } from './agent-read-error.mjs';
import {
    classifyRequest,
    productionSearchPolicy,
    readListingFromDocument,
    runListing,
    runObserve,
} from './agent-naver-search.mjs';

const WORKER_DIR_NAME = '.agbrowse-bpdus';
const PROFILE_DIR_NAME = 'agent-profile';
const ALLOWED_CONFIG_KEYS = new Set(['onDisconnected']);
const SUPPRESSED_ENV_KEYS = ['DEBUG', 'PWDEBUG', 'DEBUG_FILE'];
const IGNORED_ENV_KEYS = ['BROWSER_AGENT_HOME', 'CDP_PORT', 'AGBROWSE_CHROME_FLAGS'];

const SILENT_LOGGER = {
    isEnabled() {
        return false;
    },
    log() {},
};

export class AgentRuntimeError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     */
    constructor(code, message) {
        super(message);
        this.name = 'AgentRuntimeError';
        this.code = code;
    }
}

/**
 * @param {unknown} config
 * @returns {{ onDisconnected: (() => void) | null }}
 */
function readConfig(config) {
    if (config == null) return { onDisconnected: null };
    if (typeof config !== 'object' || Array.isArray(config)) {
        throw new AgentRuntimeError('INVALID_CONFIG', 'Configuration must be an object.');
    }
    for (const key of Object.keys(config)) {
        if (!ALLOWED_CONFIG_KEYS.has(key)) {
            throw new AgentRuntimeError('INVALID_CONFIG', 'Unknown configuration key.');
        }
    }
    const onDisconnected = /** @type {{ onDisconnected?: unknown }} */ (config).onDisconnected;
    if (onDisconnected != null && typeof onDisconnected !== 'function') {
        throw new AgentRuntimeError('INVALID_CONFIG', 'Unknown configuration key.');
    }
    return { onDisconnected: /** @type {(() => void) | null} */ (onDisconnected ?? null) };
}

/**
 * @returns {{ workerDir: string, profileDir: string }}
 */
function dedicatedPaths() {
    const workerDir = path.join(homedir(), WORKER_DIR_NAME);
    const profileDir = path.join(workerDir, PROFILE_DIR_NAME);
    return { workerDir, profileDir };
}

/**
 * @param {string} home
 * @param {string} target
 */
function assertRealDirectoryChain(home, target) {
    const relative = path.relative(home, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new AgentRuntimeError('PROFILE_UNSAFE', 'Dedicated profile is outside the expected location.');
    }
    let cursor = home;
    for (const segment of relative.split(path.sep)) {
        cursor = path.join(cursor, segment);
        if (!fs.existsSync(cursor)) return;
        const stat = fs.lstatSync(cursor);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new AgentRuntimeError('PROFILE_UNSAFE', 'Dedicated profile path is not a real directory.');
        }
    }
}

/**
 * @param {unknown} error
 * @returns {never}
 */
function rethrowProfileError(error) {
    if (error instanceof AgentRuntimeError) throw error;
    const code = error && /** @type {{ code?: string }} */ (error).code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        throw new AgentRuntimeError('PROFILE_UNWRITABLE', 'Dedicated profile directory is not writable.');
    }
    throw new AgentRuntimeError('PROFILE_UNSAFE', 'Dedicated profile directory could not be prepared.');
}

/**
 * Create the fixed profile directory or refuse. Never substitutes another profile.
 * @returns {{ workerDir: string, profileDir: string }}
 */
function ensureDedicatedProfile() {
    const home = homedir();
    const { workerDir, profileDir } = dedicatedPaths();
    try {
        const homeStat = fs.lstatSync(home);
        if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
            throw new AgentRuntimeError('PROFILE_UNSAFE', 'Dedicated profile path is not a real directory.');
        }
        assertRealDirectoryChain(home, profileDir);
        if (!fs.existsSync(workerDir)) fs.mkdirSync(workerDir);
        const workerStat = fs.lstatSync(workerDir);
        if (workerStat.isSymbolicLink() || !workerStat.isDirectory()) {
            throw new AgentRuntimeError('PROFILE_UNSAFE', 'Dedicated profile path is not a real directory.');
        }
        if (!fs.existsSync(profileDir)) fs.mkdirSync(profileDir);
        const profileStat = fs.lstatSync(profileDir);
        if (profileStat.isSymbolicLink() || !profileStat.isDirectory()) {
            throw new AgentRuntimeError('PROFILE_UNSAFE', 'Dedicated profile path is not a real directory.');
        }
        if (fs.realpathSync(workerDir) !== path.resolve(workerDir)) {
            throw new AgentRuntimeError('PROFILE_UNSAFE', 'Canonical worker path does not match the dedicated location.');
        }
        if (fs.realpathSync(profileDir) !== path.resolve(profileDir)) {
            throw new AgentRuntimeError('PROFILE_UNSAFE', 'Canonical profile path does not match the dedicated location.');
        }
        fs.accessSync(workerDir, fs.constants.W_OK);
        fs.accessSync(profileDir, fs.constants.W_OK);
    } catch (error) {
        rethrowProfileError(error);
    }
    return { workerDir, profileDir };
}

/**
 * @returns {Record<string, string>}
 */
function browserLaunchEnv() {
    /** @type {Record<string, string>} */
    const env = {};
    const skipped = new Set([...SUPPRESSED_ENV_KEYS, ...IGNORED_ENV_KEYS]);
    for (const [key, value] of Object.entries(process.env)) {
        if (value == null || skipped.has(key)) continue;
        env[key] = value;
    }
    return env;
}

/**
 * @returns {Record<string, string | undefined>}
 */
function suppressPlaywrightDebug() {
    /** @type {Record<string, string | undefined>} */
    const saved = {};
    for (const key of SUPPRESSED_ENV_KEYS) {
        saved[key] = process.env[key];
        delete process.env[key];
    }
    return saved;
}

/**
 * @param {Record<string, string | undefined> | null} saved
 */
function restorePlaywrightDebug(saved) {
    if (!saved) return;
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

/**
 * Fixed launch. Pipe transport is Playwright's default when `cdpPort` and
 * remote-debugging arguments are absent. No caller-supplied Chrome flags.
 */
function launchOptions() {
    return {
        channel: 'chrome',
        headless: false,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        logger: SILENT_LOGGER,
        env: browserLaunchEnv(),
        serviceWorkers: 'block',
    };
}

/**
 * Fixed page script. It records document mutations and is not caller input.
 */
function installEpochWatch() {
    const root = /** @type {any} */ (globalThis);
    if (root.__agbrowseEpochWatch) return root.__agbrowseDocumentEpoch || 1;
    if (!Number.isInteger(root.__agbrowseDocumentEpoch)) root.__agbrowseDocumentEpoch = 1;
    const Observer = root.MutationObserver;
    const document = root.document;
    if (typeof Observer !== 'function' || !document) return root.__agbrowseDocumentEpoch;
    const bump = () => {
        root.__agbrowseDocumentEpoch += 1;
    };
    const watchOptions = {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
    };
    /**
     * @param {unknown} target
     */
    const attach = (target) => {
        if (!target) return false;
        try {
            const observer = new Observer(bump);
            observer.observe(target, watchOptions);
            return true;
        } catch {
            return false;
        }
    };
    const element = document.documentElement;
    if (!element) {
        if (!root.__agbrowseDocumentObserved) root.__agbrowseDocumentObserved = attach(document);
        if (!root.__agbrowseEpochWatchWait && typeof document.addEventListener === 'function') {
            root.__agbrowseEpochWatchWait = true;
            document.addEventListener('DOMContentLoaded', () => {
                installEpochWatch();
            }, { once: true });
        }
        return root.__agbrowseDocumentEpoch;
    }
    if (attach(element)) root.__agbrowseEpochWatch = true;
    return root.__agbrowseDocumentEpoch;
}

const MAX_REDIRECTS = 4;

/**
 * @param {import('playwright-core').Request | { method?: () => string, url?: () => string, isNavigationRequest?: () => boolean, redirectedFrom?: () => unknown }} request
 */
function requestMethod(request) {
    const method = typeof request.method === 'function' ? request.method() : 'GET';
    return String(method || 'GET').toUpperCase();
}

/**
 * @param {import('playwright-core').Request | { url?: () => string }} request
 */
function requestUrl(request) {
    return typeof request.url === 'function' ? request.url() : '';
}

/**
 * @param {import('playwright-core').Request | { isNavigationRequest?: () => boolean }} request
 */
function requestIsNavigation(request) {
    return typeof request.isNavigationRequest === 'function' && request.isNavigationRequest();
}

/**
 * @param {import('playwright-core').Request | { redirectedFrom?: () => unknown }} request
 */
function requestRedirectedFrom(request) {
    if (typeof request.redirectedFrom !== 'function') return null;
    return request.redirectedFrom() || null;
}

/**
 * @param {{ resourceType?: () => string, url?: () => string }} request
 */
function requestIsWebSocket(request) {
    if (typeof request.resourceType === 'function' && String(request.resourceType()).toLowerCase() === 'websocket') {
        return true;
    }
    try {
        const protocol = new URL(requestUrl(request)).protocol;
        return protocol === 'ws:' || protocol === 'wss:';
    } catch {
        return false;
    }
}

/**
 * @param {{ method?: () => string, url?: () => string, isNavigationRequest?: () => boolean, resourceType?: () => string, redirectedFrom?: () => unknown }} request
 */
function chainHasWebSocket(request) {
    const seen = new Set();
    /** @type {unknown} */
    let current = request;
    while (current && typeof current === 'object' && !seen.has(current)) {
        seen.add(current);
        const hop = /** @type {{ resourceType?: () => string, url?: () => string, redirectedFrom?: () => unknown }} */ (current);
        if (requestIsWebSocket(hop)) return true;
        current = requestRedirectedFrom(hop);
    }
    return false;
}

/**
 * @param {{ method?: () => string, url?: () => string, isNavigationRequest?: () => boolean, resourceType?: () => string }} request
 * @param {ReturnType<typeof productionSearchPolicy>} policy
 */
function hopAllowed(request, policy) {
    if (requestIsWebSocket(request)) return false;
    const method = requestMethod(request);
    const url = requestUrl(request);
    const navigation = requestIsNavigation(request);
    if (navigation && method !== 'GET') return false;
    return classifyRequest(url, method, navigation ? 'navigation' : 'resource', policy) === 'allow';
}

/**
 * @param {{ method?: () => string, url?: () => string, isNavigationRequest?: () => boolean, redirectedFrom?: () => unknown }} request
 * @param {ReturnType<typeof productionSearchPolicy>} policy
 */
function redirectChainAllowed(request, policy) {
    const seen = new Set();
    /** @type {unknown} */
    let current = request;
    while (current && typeof current === 'object' && !seen.has(current)) {
        seen.add(current);
        const hop = /** @type {{ method?: () => string, url?: () => string, isNavigationRequest?: () => boolean, redirectedFrom?: () => unknown }} */ (current);
        if (!hopAllowed(hop, policy)) return false;
        current = requestRedirectedFrom(hop);
    }
    return true;
}

/**
 * @param {{ abort: (errorCode?: string) => Promise<void> }} route
 */
async function abortRoute(route) {
    try {
        await route.abort('blockedbyclient');
    } catch {
        /* already settled */
    }
}

/**
 * Classify the current request and every prior redirect before any fetch.
 * A 3xx Location is classified before the next hop is requested.
 * @param {import('playwright-core').Route} route
 */
async function guardRequest(route) {
    const policy = productionSearchPolicy();
    try {
        const request = route.request();
        const method = requestMethod(request);
        const url = requestUrl(request);
        if (chainHasWebSocket(request)) {
            await abortRoute(route);
            return;
        }
        if (url === 'about:blank' && method === 'GET' && !requestRedirectedFrom(request)) {
            await route.continue();
            return;
        }
        if (!redirectChainAllowed(request, policy)) {
            await abortRoute(route);
            return;
        }
        const navigation = requestIsNavigation(request);
        let nextMethod = method;
        let nextUrl = url;
        let response = await route.fetch({ maxRedirects: 0 });
        for (let followed = 0; ; followed += 1) {
            const status = typeof response.status === 'function' ? response.status() : 0;
            if (status < 300 || status >= 400) {
                await route.fulfill({ response });
                return;
            }
            if (followed >= MAX_REDIRECTS) {
                await abortRoute(route);
                return;
            }
            const headers = typeof response.headers === 'function' ? response.headers() : null;
            const location = headers && (headers.location || headers.Location);
            if (typeof location !== 'string' || location.length === 0) {
                await route.fulfill({ response });
                return;
            }
            let resolved;
            try {
                resolved = new URL(location, nextUrl).toString();
            } catch {
                await abortRoute(route);
                return;
            }
            const followMethod = status === 307 || status === 308 ? nextMethod : 'GET';
            if (navigation && followMethod !== 'GET') {
                await abortRoute(route);
                return;
            }
            if (classifyRequest(resolved, followMethod, navigation ? 'navigation' : 'resource', policy) !== 'allow') {
                await abortRoute(route);
                return;
            }
            nextMethod = followMethod;
            nextUrl = resolved;
            response = await route.fetch({ url: resolved, method: followMethod, maxRedirects: 0 });
        }
    } catch {
        await abortRoute(route);
    }
}

/**
 * The read MVP never connects a socket. Closing here does not reach the server.
 * @param {import('playwright-core').WebSocketRoute} ws
 */
async function guardWebSocket(ws) {
    try {
        await ws.close({ code: 1008 });
    } catch {
        /* already closed */
    }
}

/**
 * @param {import('playwright-core').BrowserContext} ctx
 */
async function installContextGuards(ctx) {
    if (typeof ctx.route !== 'function' || typeof ctx.addInitScript !== 'function') {
        throw new AgentRuntimeError('STARTUP_FAILED', 'Browser launch failed.');
    }
    await ctx.route('**/*', (route) => guardRequest(route));
    if (typeof ctx.routeWebSocket === 'function') {
        /** @type {(url: URL) => boolean} */
        const allWebSockets = () => true;
        await ctx.routeWebSocket(allWebSockets, (ws) => guardWebSocket(ws));
    }
    await ctx.addInitScript(installEpochWatch);
}

/**
 * @param {unknown} [config]
 */
export function createAgentRuntime(config) {
    const { onDisconnected } = readConfig(config);
    /** @type {'idle' | 'running' | 'closing' | 'stopped'} */
    let state = 'idle';
    /** @type {'stopped' | 'disconnected' | null} */
    let stopReason = null;
    /** @type {import('playwright-core').BrowserContext | null} */
    let context = null;
    /** @type {string | null} */
    let lockToken = null;
    /** @type {string | null} */
    let lockedDir = null;
    /** @type {Map<string, { page: import('playwright-core').Page, targetId: string, epoch: number, seenPageEpoch: number, policyApplied: boolean }>} */
    const sessions = new Map();
    let intentionalStop = false;
    let disconnectNoted = false;
    /** @type {Record<string, string | undefined> | null} */
    let savedDebug = null;
    let chain = Promise.resolve();

    /**
     * @param {() => Promise<void> | void} task
     * @returns {Promise<void>}
     */
    function enqueue(task) {
        const run = chain.then(() => task());
        chain = run.then(() => undefined, () => undefined);
        return run;
    }

    function assertRunning() {
        if (state === 'running' && context && !intentionalStop) return;
        if (stopReason === 'disconnected') {
            throw new AgentRuntimeError('BROWSER_DISCONNECTED', 'Browser disconnected.');
        }
        throw new AgentRuntimeError('NOT_RUNNING', 'Agent runtime is not running.');
    }

    /**
     * Close the owned browser before releasing its lock.
     * A rejected close leaves the context and token in place so stop() can retry.
     */
    async function releaseOwnedBrowser() {
        const ctx = context;
        if (ctx) await ctx.close();
        const dir = lockedDir;
        const token = lockToken;
        context = null;
        lockToken = null;
        lockedDir = null;
        if (token && dir) releaseProfileLock(dir, token);
    }

    /**
     * @param {unknown} error
     * @returns {never}
     */
    function throwShutdownFailure(error) {
        if (error instanceof AgentRuntimeError) throw error;
        throw new AgentRuntimeError('SHUTDOWN_FAILED', 'Browser shutdown failed.');
    }

    async function discardLaunch() {
        sessions.clear();
        try {
            await releaseOwnedBrowser();
        } catch (error) {
            state = 'closing';
            intentionalStop = true;
            throwShutdownFailure(error);
        }
        state = 'idle';
        stopReason = null;
        intentionalStop = false;
        disconnectNoted = false;
        restorePlaywrightDebug(savedDebug);
        savedDebug = null;
    }

    function noteDisconnect() {
        if (intentionalStop || disconnectNoted) return;
        disconnectNoted = true;
        void enqueue(() => applyDisconnect());
    }

    async function applyDisconnect() {
        if (intentionalStop || state === 'idle') return;
        if (state === 'stopped' && !context && !lockToken) return;
        sessions.clear();
        state = 'closing';
        stopReason = 'disconnected';
        try {
            await releaseOwnedBrowser();
            state = 'stopped';
            restorePlaywrightDebug(savedDebug);
            savedDebug = null;
        } catch {
            // Chrome may still be alive. Keep the context and lock for stop().
        }
        if (onDisconnected) onDisconnected();
    }

    /**
     * @param {import('playwright-core').BrowserContext} ctx
     */
    function watchContext(ctx) {
        const browser = typeof ctx.browser === 'function' ? ctx.browser() : null;
        if (browser && typeof browser.on === 'function') {
            browser.on('disconnected', () => noteDisconnect());
        }
        if (typeof ctx.on === 'function') {
            ctx.on('close', () => noteDisconnect());
        }
    }

    /**
     * @param {import('playwright-core').Page} page
     */
    async function readTargetId(page) {
        if (!context) throw new AgentRuntimeError('BROWSER_DISCONNECTED', 'Browser disconnected.');
        if (typeof page.url === 'function' && page.url() !== 'about:blank') {
            throw new AgentRuntimeError('SESSION_CLOSED', 'Session target is closed.');
        }
        /** @type {{ detach: () => Promise<void>, send: (method: string) => Promise<{ targetInfo?: { targetId?: string } }> } | null} */
        let cdp = null;
        try {
            cdp = await context.newCDPSession(page);
            const info = await cdp.send('Target.getTargetInfo');
            const targetId = info && info.targetInfo && info.targetInfo.targetId;
            if (typeof targetId !== 'string' || !targetId) {
                throw new AgentRuntimeError('SESSION_CLOSED', 'Session target is closed.');
            }
            return targetId;
        } finally {
            if (cdp) {
                try { await cdp.detach(); } catch { /* detached */ }
            }
        }
    }

    async function start() {
        return enqueue(async () => {
            if (state === 'running' || state === 'closing' || context || lockToken) {
                throw new AgentRuntimeError('ALREADY_RUNNING', 'Agent runtime is already running.');
            }
            intentionalStop = false;
            disconnectNoted = false;
            stopReason = null;
            savedDebug = suppressPlaywrightDebug();
            try {
                const { workerDir, profileDir } = ensureDedicatedProfile();
                let lock;
                try {
                    lock = acquireProfileLock(workerDir);
                } catch {
                    throw new AgentRuntimeError('LOCK_HELD', 'Profile lock is held.');
                }
                lockToken = lock.token;
                lockedDir = workerDir;
                const playwright = await import('playwright-core');
                context = await playwright.chromium.launchPersistentContext(profileDir, launchOptions());
                watchContext(context);
                if (disconnectNoted) {
                    throw new AgentRuntimeError('BROWSER_DISCONNECTED', 'Browser disconnected.');
                }
                await installContextGuards(context);
                if (disconnectNoted) {
                    throw new AgentRuntimeError('BROWSER_DISCONNECTED', 'Browser disconnected.');
                }
                state = 'running';
            } catch (error) {
                await discardLaunch();
                if (error instanceof AgentRuntimeError) throw error;
                throw new AgentRuntimeError('STARTUP_FAILED', 'Browser launch failed.');
            }
        });
    }

    async function openSessionUnlocked() {
        assertRunning();
        const ctx = context;
        if (!ctx) throw new AgentRuntimeError('BROWSER_DISCONNECTED', 'Browser disconnected.');
        /** @type {import('playwright-core').Page | undefined} */
        let page;
        try {
            page = await ctx.newPage();
            const targetId = await readTargetId(page);
            if (disconnectNoted || state !== 'running' || intentionalStop) {
                throw new AgentRuntimeError('BROWSER_DISCONNECTED', 'Browser disconnected.');
            }
            const sessionId = `ses_${randomBytes(8).toString('hex')}`;
            sessions.set(sessionId, { page, targetId, epoch: 1, seenPageEpoch: 0, policyApplied: false });
            return { sessionId, targetId };
        } catch (error) {
            if (page) {
                try { await page.close(); } catch { /* already closed */ }
            }
            if (error instanceof AgentRuntimeError) throw error;
            if (disconnectNoted || state !== 'running' || intentionalStop) {
                throw new AgentRuntimeError('BROWSER_DISCONNECTED', 'Browser disconnected.');
            }
            throw new AgentRuntimeError('SESSION_CLOSED', 'Session target is closed.');
        }
    }

    async function openSession() {
        return enqueue(() => openSessionUnlocked());
    }

    /**
     * @param {string} sessionId
     */
    function requireBinding(sessionId) {
        const binding = sessions.get(sessionId);
        if (!binding) throw new AgentRuntimeError('SESSION_NOT_FOUND', 'Session was not found.');
        if (typeof binding.page.isClosed === 'function' && binding.page.isClosed()) {
            sessions.delete(sessionId);
            throw new AgentRuntimeError('SESSION_CLOSED', 'Session target is closed.');
        }
        return binding;
    }

    /**
     * @param {string} sessionId
     */
    async function inspectSessionUnlocked(sessionId) {
        assertRunning();
        const binding = requireBinding(sessionId);
        return { sessionId, targetId: binding.targetId };
    }

    /**
     * @param {string} sessionId
     */
    async function inspectSession(sessionId) {
        return enqueue(() => inspectSessionUnlocked(sessionId));
    }

    /**
     * @param {string} sessionId
     */
    async function closeSessionUnlocked(sessionId) {
        assertRunning();
        const binding = sessions.get(sessionId);
        if (!binding) throw new AgentRuntimeError('SESSION_NOT_FOUND', 'Session was not found.');
        sessions.delete(sessionId);
        if (typeof binding.page.isClosed === 'function' && binding.page.isClosed()) {
            throw new AgentRuntimeError('SESSION_CLOSED', 'Session target is closed.');
        }
        try {
            await binding.page.close();
        } catch {
            throw new AgentRuntimeError('SESSION_CLOSED', 'Session target is closed.');
        }
    }

    /**
     * @param {string} sessionId
     */
    async function closeSession(sessionId) {
        return enqueue(() => closeSessionUnlocked(sessionId));
    }

    /**
     * @param {import('playwright-core').Page} page
     * @param {{ epoch: number, seenPageEpoch: number, policyApplied: boolean }} binding
     */
    async function applyReadPolicy(page, binding) {
        if (binding.policyApplied) return;
        binding.policyApplied = true;
        if (typeof page.on === 'function') {
            page.on('popup', (popup) => {
                if (popup && typeof popup.close === 'function') {
                    Promise.resolve(popup.close()).catch(() => {});
                }
            });
            page.on('framenavigated', (frame) => {
                const main = typeof page.mainFrame === 'function' ? page.mainFrame() : null;
                if (main && frame && frame !== main) return;
                binding.epoch += 1;
                binding.seenPageEpoch = 0;
                if (typeof page.evaluate === 'function') {
                    Promise.resolve(page.evaluate(installEpochWatch)).catch(() => {});
                }
            });
        }
    }

    /**
     * @param {import('playwright-core').Page} page
     * @param {{ epoch: number }} binding
     * @param {string} url
     */
    async function gotoAllowed(page, binding, url) {
        const policy = productionSearchPolicy();
        if (classifyRequest(url, 'GET', 'navigation', policy) !== 'allow') throw readError('DOMAIN_DENIED');
        if (typeof page.goto !== 'function') throw readError('NOT_RUNNING');
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const finalUrl = typeof page.url === 'function' ? page.url() : url;
        if (classifyRequest(finalUrl, 'GET', 'navigation', policy) !== 'allow') throw readError('DOMAIN_DENIED');
        return { finalUrl };
    }

    /**
     * @param {import('playwright-core').Page} page
     * @param {{ epoch: number, seenPageEpoch: number }} binding
     */
    async function inspectPage(page, binding) {
        /** @type {{ blocked?: boolean, reason?: string | null, results?: Array<{ rank: number, title: string, snippet: string, href: string }> }} */
        let extracted = { blocked: false, reason: 'SITE_UNSUPPORTED', results: [] };
        if (typeof page.evaluate === 'function') {
            const value = await page.evaluate(readListingFromDocument);
            if (value && typeof value === 'object') extracted = value;
            const watched = await page.evaluate(() => {
                const epoch = /** @type {any} */ (globalThis).__agbrowseDocumentEpoch;
                return typeof epoch === 'number' ? epoch : 1;
            });
            if (Number.isInteger(watched) && watched > binding.seenPageEpoch) {
                binding.epoch += watched - binding.seenPageEpoch;
                binding.seenPageEpoch = watched;
            }
        }
        const title = typeof page.title === 'function' ? await page.title() : '';
        const finalUrl = typeof page.url === 'function' ? page.url() : '';
        return {
            blocked: Boolean(extracted.blocked),
            reason: extracted.reason ?? null,
            results: Array.isArray(extracted.results) ? extracted.results : [],
            title: typeof title === 'string' ? title : '',
            finalUrl: typeof finalUrl === 'string' ? finalUrl : '',
            epoch: binding.epoch,
        };
    }

    /**
     * @param {import('playwright-core').Page} page
     * @param {{ epoch: number, seenPageEpoch: number, policyApplied: boolean }} binding
     */
    function readPort(page, binding) {
        return {
            async applyPolicy() {
                await applyReadPolicy(page, binding);
            },
            async goto(url) {
                return gotoAllowed(page, binding, url);
            },
            async inspect() {
                return inspectPage(page, binding);
            },
            url() {
                return typeof page.url === 'function' ? page.url() : '';
            },
        };
    }

    /**
     * @param {unknown} error
     * @returns {never}
     */
    function asPublicReadError(error) {
        if (error instanceof AgentReadError) throw error;
        if (error instanceof AgentRuntimeError) {
            if (Object.hasOwn(READ_ERROR_MESSAGES, error.code)) throw readError(error.code);
            throw error;
        }
        if (disconnectNoted || state !== 'running' || intentionalStop) {
            throw readError('BROWSER_DISCONNECTED');
        }
        throw readError('SESSION_CLOSED');
    }

    /**
     * One queued read operation. Caller policy is ignored.
     * @param {string} op
     * @param {Record<string, unknown>} [payload]
     */
    async function dispatchRead(op, payload = {}) {
        return enqueue(async () => {
            try {
                assertRunning();
                if (op === 'browser.session.open') {
                    const opened = await openSessionUnlocked();
                    return {
                        session_id: opened.sessionId,
                        tab_id: opened.targetId,
                        frame_id: 'frame_main',
                        document_epoch: 1,
                    };
                }
                const sessionId = payload.session_id;
                if (typeof sessionId !== 'string') throw readError('INVALID_ARGUMENTS');
                if (op === 'browser.session.close') {
                    await closeSessionUnlocked(sessionId);
                    return { closed: true };
                }
                const binding = requireBinding(sessionId);
                const port = readPort(binding.page, binding);
                const policy = productionSearchPolicy();
                if (op === 'browser.observe' || op === 'naver.search.result.read') {
                    const observed = await runObserve(port, policy);
                    return {
                        ...observed,
                        session_id: sessionId,
                        tab_id: binding.targetId,
                        frame_id: 'frame_main',
                    };
                }
                if (op === 'naver.search.list') {
                    if (typeof payload.query !== 'string') throw readError('INVALID_ARGUMENTS');
                    const listed = await runListing(port, {
                        query: payload.query,
                        policy,
                        maxNodes: typeof payload.max_nodes === 'number' ? payload.max_nodes : undefined,
                    });
                    return {
                        ...listed,
                        session_id: sessionId,
                        tab_id: binding.targetId,
                        frame_id: 'frame_main',
                    };
                }
                throw readError('ACTION_DENIED');
            } catch (error) {
                throw asPublicReadError(error);
            }
        });
    }

    async function stop() {
        return enqueue(async () => {
            if (!context && !lockToken && state !== 'running' && state !== 'closing') return;
            intentionalStop = true;
            if (stopReason !== 'disconnected') stopReason = 'stopped';
            sessions.clear();
            state = 'closing';
            try {
                await releaseOwnedBrowser();
            } catch (error) {
                throwShutdownFailure(error);
            }
            state = 'stopped';
            restorePlaywrightDebug(savedDebug);
            savedDebug = null;
        });
    }

    return { start, openSession, inspectSession, closeSession, stop, dispatchRead };
}
