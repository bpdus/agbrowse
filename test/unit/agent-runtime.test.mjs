import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { state, locks, trace } = vi.hoisted(() => ({
    state: { home: '' },
    locks: {
        acquire: vi.fn(),
        release: vi.fn(),
    },
    trace: {
        loads: 0,
        launches: [],
        connectOverCDP: 0,
        browserLaunch: 0,
        launchImpl: null,
    },
}));

vi.mock('node:os', async () => {
    const actual = await vi.importActual('node:os');
    return { ...actual, homedir: () => state.home };
});

vi.mock('../../skills/browser/profile-lock.mjs', () => ({
    acquireProfileLock: (...args) => locks.acquire(...args),
    releaseProfileLock: (...args) => locks.release(...args),
}));

vi.mock('playwright-core', () => {
    trace.loads += 1;
    return {
        chromium: {
            async launchPersistentContext(userDataDir, options) {
                trace.launches.push({ userDataDir, options });
                if (!trace.launchImpl) throw new Error('launchImpl not set');
                return trace.launchImpl(userDataDir, options);
            },
            async connectOverCDP() {
                trace.connectOverCDP += 1;
                throw new Error('connectOverCDP');
            },
            async launch() {
                trace.browserLaunch += 1;
                throw new Error('chromium.launch');
            },
        },
    };
});

const { createAgentRuntime } = await import('../../skills/browser/agent-runtime.mjs');

const runtimeSource = readFileSync(new URL('../../skills/browser/agent-runtime.mjs', import.meta.url), 'utf8');
const loadsAtImport = trace.loads;
const acquireAtImport = locks.acquire.mock.calls.length;
const ENV_KEYS = ['BROWSER_AGENT_HOME', 'CDP_PORT', 'AGBROWSE_CHROME_FLAGS', 'DEBUG', 'PWDEBUG', 'DEBUG_FILE'];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
    for (const key of ENV_KEYS) {
        const value = ORIGINAL_ENV[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
}

function workerDir() {
    return join(state.home, '.agbrowse-bpdus');
}

function profileDir() {
    return join(workerDir(), 'agent-profile');
}

function makePage(targetId, url = 'about:blank') {
    return {
        targetId,
        currentUrl: url,
        closed: false,
        cdpAttached: 0,
        focused: false,
        url() { return this.currentUrl; },
        isClosed() { return this.closed; },
        async close() { this.closed = true; },
        async bringToFront() { this.focused = true; },
    };
}

function makeContext(events) {
    const order = [];
    const closeListeners = [];
    const disconnectListeners = [];
    let seq = 0;
    const browser = {
        on(event, fn) {
            if (event !== 'disconnected') throw new Error(`unexpected browser event ${event}`);
            disconnectListeners.push(fn);
        },
        emitDisconnected() {
            for (const fn of [...disconnectListeners]) fn();
        },
    };
    const context = {
        order,
        closed: false,
        newPageCalls: [],
        routes: [],
        webSocketRoutes: [],
        initScripts: [],
        installOrder: [],
        async route(pattern, handler) {
            this.installOrder.push('route');
            this.routes.push({ pattern, handler });
        },
        async routeWebSocket(pattern, handler) {
            this.installOrder.push('routeWebSocket');
            this.webSocketRoutes.push({ pattern, handler });
        },
        async addInitScript(script) {
            this.installOrder.push('addInitScript');
            this.initScripts.push(script);
        },
        async newPage(...args) {
            this.installOrder.push('newPage');
            this.newPageCalls.push(args);
            seq += 1;
            const page = makePage(`target-${seq}`);
            order.push(page);
            return page;
        },
        pages() {
            throw new Error('pages() must not decide the session target');
        },
        async newCDPSession(page) {
            page.cdpAttached += 1;
            return {
                async send(method) {
                    if (method !== 'Target.getTargetInfo') throw new Error(`unexpected CDP ${method}`);
                    return { targetInfo: { targetId: page.targetId, url: page.currentUrl } };
                },
                async detach() {
                    page.cdpAttached -= 1;
                },
            };
        },
        async close() {
            events.push('close');
            this.closed = true;
            for (const fn of [...closeListeners]) fn();
            browser.emitDisconnected();
        },
        browser: () => browser,
        on(event, fn) {
            if (event === 'page') throw new Error('restored tabs must not be enrolled');
            if (event !== 'close') throw new Error(`unexpected context event ${event}`);
            closeListeners.push(fn);
        },
    };
    return { context, browser, order };
}

describe('agent-runtime', () => {
    /** @type {string[]} */
    let events;
    /** @type {{ stop: () => Promise<void> } | null} */
    let active;

    beforeEach(() => {
        restoreEnv();
        state.home = realpathSync(mkdtempSync(join(tmpdir(), 'agb-agent-')));
        events = [];
        active = null;
        trace.launches.length = 0;
        trace.connectOverCDP = 0;
        trace.browserLaunch = 0;
        trace.launchImpl = () => makeContext(events).context;
        locks.acquire.mockReset();
        locks.release.mockReset();
        let tokenNo = 0;
        locks.acquire.mockImplementation((dir) => {
            tokenNo += 1;
            return { pid: process.pid, token: `tok-${tokenNo}`, path: join(dir, 'profile.lock') };
        });
        locks.release.mockImplementation(() => {
            events.push('release');
        });
    });

    afterEach(async () => {
        if (active) await active.stop().catch(() => {});
        restoreEnv();
        if (state.home) {
            for (const dir of [profileDir(), workerDir()]) {
                try { chmodSync(dir, 0o755); } catch { /* absent */ }
            }
            rmSync(state.home, { recursive: true, force: true });
        }
    });

    it('does nothing on import', () => {
        expect(loadsAtImport).toBe(0);
        expect(acquireAtImport).toBe(0);
        expect(runtimeSource).not.toMatch(/process\.argv|console\.(log|error|warn|info)/);
        expect(runtimeSource).not.toMatch(/browser\.mjs|tab-manager|web-ai\/cli\.mjs|web-ai\/mcp-server\.mjs|adaptive-fetch|connectOverCDP|remote-debugging-port|createServer/);
        expect(existsSync(workerDir())).toBe(false);
    });

    it('returns only the lifecycle methods', () => {
        const runtime = createAgentRuntime();
        expect(Object.keys(runtime).sort()).toEqual(['closeSession', 'dispatchCart', 'dispatchRead', 'inspectSession', 'openSession', 'start', 'stop']);
    });

    it('serializes cart inspection through the runtime queue and fails live layouts closed', async () => {
        const made = makeContext(events);
        const pages = [makePage('cart-one'), makePage('cart-two')];
        let pageIndex = 0;
        made.context.newPage = async () => pages[pageIndex++];
        let releaseFirst;
        const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
        let activeEvaluations = 0;
        let maxActive = 0;
        let evaluationCount = 0;
        pages[0].evaluate = async () => {
            evaluationCount += 1;
            activeEvaluations += 1;
            maxActive = Math.max(maxActive, activeEvaluations);
            await firstGate;
            activeEvaluations -= 1;
            return { login: false, human: false };
        };
        pages[1].evaluate = async () => {
            evaluationCount += 1;
            activeEvaluations += 1;
            maxActive = Math.max(maxActive, activeEvaluations);
            activeEvaluations -= 1;
            return { login: false, human: false };
        };
        trace.launchImpl = () => made.context;
        const runtime = createAgentRuntime();
        active = runtime;
        await runtime.start();
        const first = await runtime.openSession();
        const second = await runtime.openSession();
        pages[0].currentUrl = 'https://shopping.naver.com/products/one';
        pages[1].currentUrl = 'https://shopping.naver.com/products/two';
        const payload = (session_id) => ({
            session_id,
            mcp_session_id: `mcp_${'b'.repeat(16)}`,
            device_id: 'dev_test',
            epoch: 1,
            worker_id: `wrk_${'a'.repeat(16)}`,
        });
        const pendingOne = runtime.dispatchCart('naver.cart.read', payload(first.sessionId));
        await new Promise((resolve) => setImmediate(resolve));
        const pendingTwo = runtime.dispatchCart('naver.cart.read', payload(second.sessionId));
        await new Promise((resolve) => setImmediate(resolve));
        expect(evaluationCount).toBe(1);
        releaseFirst();
        const outcomes = await Promise.allSettled([pendingOne, pendingTwo]);
        expect(outcomes.every((outcome) => outcome.status === 'rejected' && outcome.reason.code === 'SITE_UNSUPPORTED')).toBe(true);
        expect(evaluationCount).toBe(2);
        expect(maxActive).toBe(1);
    });

    it('returns LOGIN_REQUIRED for a recognized login form without reading its value', async () => {
        const made = makeContext(events);
        const page = makePage('cart-login');
        page.evaluate = async () => ({ login: true, human: false, value: 'canary-password-value' });
        made.context.newPage = async () => page;
        trace.launchImpl = () => made.context;
        const runtime = createAgentRuntime();
        active = runtime;
        await runtime.start();
        const opened = await runtime.openSession();
        page.currentUrl = 'https://shopping.naver.com/products/one';
        await expect(runtime.dispatchCart('naver.product.read', {
            session_id: opened.sessionId, mcp_session_id: `mcp_${'b'.repeat(16)}`,
            device_id: 'dev_test', epoch: 1, worker_id: `wrk_${'a'.repeat(16)}`,
        })).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
    });

    it('blocks Naver login redirects before fetching them and records blocked order attempts', async () => {
        const made = makeContext(events);
        const loginPage = makePage('cart-login-redirect');
        const orderPage = makePage('cart-order-attempt');
        loginPage.evaluate = async () => { throw new Error('login destination must not be inspected'); };
        orderPage.evaluate = async () => ({ login: false, human: false });
        const pages = [loginPage, orderPage];
        let index = 0;
        made.context.newPage = async () => pages[index++];
        trace.launchImpl = () => made.context;
        const runtime = createAgentRuntime();
        active = runtime;
        await runtime.start();
        const loginSession = await runtime.openSession();
        const orderSession = await runtime.openSession();
        loginPage.currentUrl = 'https://shopping.naver.com/products/one';
        orderPage.currentUrl = 'https://shopping.naver.com/products/two';
        const handler = made.context.routes[0].handler;
        const loginFetches = [];
        let loginAbort = null;
        await handler({
            request: () => makeRoutedRequest('https://nid.naver.com/nidlogin.login', { page: loginPage }),
            async abort(reason) { loginAbort = reason; },
            async fetch(options) { loginFetches.push(options); return { status: () => 200 }; },
            async fulfill() {},
            async continue() {},
        });
        expect(loginAbort).toBe('blockedbyclient');
        expect(loginFetches).toEqual([]);
        await expect(runtime.dispatchCart('naver.product.read', {
            session_id: loginSession.sessionId, mcp_session_id: `mcp_${'b'.repeat(16)}`,
            device_id: 'dev_test', epoch: 1, worker_id: `wrk_${'a'.repeat(16)}`,
        })).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });

        let orderAbort = null;
        const orderFetches = [];
        await handler({
            request: () => makeRoutedRequest('https://shopping.naver.com/checkout', { page: orderPage }),
            async abort(reason) { orderAbort = reason; },
            async fetch(options) { orderFetches.push(options); return { status: () => 200 }; },
            async fulfill() {},
            async continue() {},
        });
        expect(orderAbort).toBe('blockedbyclient');
        expect(orderFetches).toEqual([]);
        await expect(runtime.dispatchCart('naver.cart.set', {
            session_id: orderSession.sessionId, mcp_session_id: `mcp_${'b'.repeat(16)}`,
            device_id: 'dev_test', epoch: 1, worker_id: `wrk_${'a'.repeat(16)}`,
        })).rejects.toMatchObject({ code: 'ORDER_CREATION_DETECTED' });
    });

    it('rejects a foreign profile or endpoint before launch', async () => {
        const owner = { closed: false };
        expect(() => createAgentRuntime({
            profile: join(state.home, '.browser-agent', 'browser-profile'),
            endpoint: 'http://127.0.0.1:9222',
            port: 9222,
            userDataDir: '/tmp/default-profile',
            args: ['--remote-debugging-port=9222'],
            channel: 'chromium',
            headless: true,
            executablePath: '/usr/bin/chrome',
        })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
        expect(trace.launches).toHaveLength(0);
        expect(trace.connectOverCDP).toBe(0);
        expect(trace.browserLaunch).toBe(0);
        expect(locks.acquire).not.toHaveBeenCalled();
        expect(locks.release).not.toHaveBeenCalled();
        expect(owner.closed).toBe(false);
        expect(existsSync(workerDir())).toBe(false);
    });

    it('refuses a symlinked dedicated profile and does not fall back', async () => {
        const elsewhere = mkdtempSync(join(tmpdir(), 'agb-link-target-'));
        symlinkSync(elsewhere, workerDir());
        const runtime = createAgentRuntime();
        active = runtime;
        await expect(runtime.start()).rejects.toMatchObject({ code: 'PROFILE_UNSAFE' });
        expect(trace.launches).toHaveLength(0);
        expect(locks.acquire).not.toHaveBeenCalled();
        expect(existsSync(join(state.home, '.browser-agent'))).toBe(false);
        expect(lstatSync(workerDir()).isSymbolicLink()).toBe(true);
        rmSync(elsewhere, { recursive: true, force: true });
    });

    it('refuses an unwritable dedicated profile and does not fall back', async () => {
        mkdirSync(profileDir(), { recursive: true });
        chmodSync(profileDir(), 0o555);
        const runtime = createAgentRuntime();
        active = runtime;
        await expect(runtime.start()).rejects.toMatchObject({ code: 'PROFILE_UNWRITABLE' });
        expect(trace.launches).toHaveLength(0);
        expect(locks.acquire).not.toHaveBeenCalled();
        expect(existsSync(join(state.home, '.browser-agent'))).toBe(false);
    });

    it('launches installed Chrome over the debugging pipe', async () => {
        process.env.BROWSER_AGENT_HOME = '/tmp/legacy-secret-home';
        process.env.CDP_PORT = '9222';
        process.env.AGBROWSE_CHROME_FLAGS = '--remote-debugging-port=9222 --user-data-dir=/tmp/secret-profile';
        process.env.DEBUG = 'pw:api SECRET_DEBUG_TOKEN';
        let debugAtLaunch;
        const made = makeContext(events);
        trace.launchImpl = () => {
            debugAtLaunch = process.env.DEBUG;
            return made.context;
        };
        const runtime = createAgentRuntime();
        active = runtime;
        await runtime.start();
        expect(locks.acquire).toHaveBeenCalledTimes(1);
        expect(locks.acquire.mock.calls[0][0]).toBe(workerDir());
        expect(trace.launches).toHaveLength(1);
        const launch = trace.launches[0];
        expect(launch.userDataDir).toBe(profileDir());
        expect(launch.options.channel).toBe('chrome');
        expect(launch.options.headless).toBe(false);
        expect(launch.options.args).toBeUndefined();
        expect(launch.options.cdpPort).toBeUndefined();
        expect(launch.options.handleSIGINT).toBe(false);
        expect(launch.options.handleSIGTERM).toBe(false);
        expect(launch.options.handleSIGHUP).toBe(false);
        expect(launch.options.logger.isEnabled()).toBe(false);
        expect(launch.options.env.BROWSER_AGENT_HOME).toBeUndefined();
        expect(launch.options.env.CDP_PORT).toBeUndefined();
        expect(launch.options.env.AGBROWSE_CHROME_FLAGS).toBeUndefined();
        expect(launch.options.env.DEBUG).toBeUndefined();
        expect(JSON.stringify(launch.options)).not.toMatch(/remote-debugging-port|remote-debugging-address|9222|legacy-secret-home|secret-profile/);
        expect(trace.connectOverCDP).toBe(0);
        expect(trace.browserLaunch).toBe(0);
        expect(debugAtLaunch).toBeUndefined();
        expect(made.context.newPageCalls).toHaveLength(0);
    });

    it('keeps two sessions on their own targets when tabs move', async () => {
        const made = makeContext(events);
        trace.launchImpl = () => made.context;
        const runtime = createAgentRuntime();
        active = runtime;
        await runtime.start();
        const first = await runtime.openSession();
        const second = await runtime.openSession();
        expect(Object.keys(first).sort()).toEqual(['sessionId', 'targetId']);
        expect(first.targetId).toBe('target-1');
        expect(second.targetId).toBe('target-2');
        expect(first.sessionId).not.toBe(second.sessionId);
        expect(made.order[0].cdpAttached).toBe(0);
        expect(made.order[1].cdpAttached).toBe(0);
        expect(made.context.newPageCalls).toEqual([[], []]);
        made.order.reverse();
        await made.order[0].bringToFront();
        made.order[0].focused = true;
        expect(await runtime.inspectSession(first.sessionId)).toEqual(first);
        expect(await runtime.inspectSession(second.sessionId)).toEqual(second);
        made.context.emit?.('page', makePage('restored-target'));
        expect(await runtime.inspectSession(first.sessionId)).toEqual({ sessionId: first.sessionId, targetId: 'target-1' });
    });

    it('fails a closed target without substituting another tab', async () => {
        const made = makeContext(events);
        trace.launchImpl = () => made.context;
        const runtime = createAgentRuntime();
        active = runtime;
        await runtime.start();
        const first = await runtime.openSession();
        const second = await runtime.openSession();
        await made.order[0].close();
        await expect(runtime.inspectSession(first.sessionId)).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
        expect(await runtime.inspectSession(second.sessionId)).toEqual(second);
        await expect(runtime.inspectSession('ses_missing')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
        await runtime.closeSession(second.sessionId);
        expect(made.order[1].closed).toBe(true);
        expect(made.context.closed).toBe(false);
        await expect(runtime.inspectSession(second.sessionId)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    });

    it('clears bindings on disconnect and does not relaunch or replay', async () => {
        const made = makeContext(events);
        trace.launchImpl = () => made.context;
        let disconnected;
        const disconnectedPromise = new Promise((resolve) => { disconnected = resolve; });
        const runtime = createAgentRuntime({ onDisconnected: () => disconnected() });
        active = runtime;
        await runtime.start();
        const first = await runtime.openSession();
        made.browser.emitDisconnected();
        await disconnectedPromise;
        await expect(runtime.inspectSession(first.sessionId)).rejects.toMatchObject({ code: 'BROWSER_DISCONNECTED' });
        await expect(runtime.openSession()).rejects.toMatchObject({ code: 'BROWSER_DISCONNECTED' });
        expect(trace.launches).toHaveLength(1);
        expect(events).toEqual(['close', 'release']);
        expect(locks.release).toHaveBeenCalledWith(workerDir(), 'tok-1');
    });

    it('closes Chrome before releasing the lock and rejects old ids after restart', async () => {
        const contexts = [makeContext(events), makeContext(events)];
        let n = 0;
        trace.launchImpl = () => contexts[n++].context;
        const runtime = createAgentRuntime();
        active = runtime;
        await runtime.start();
        const first = await runtime.openSession();
        await runtime.stop();
        expect(events).toEqual(['close', 'release']);
        expect(locks.release).toHaveBeenCalledWith(workerDir(), 'tok-1');
        await runtime.stop();
        expect(locks.release).toHaveBeenCalledTimes(1);
        await runtime.start();
        const second = await runtime.openSession();
        expect(second.sessionId).not.toBe(first.sessionId);
        await expect(runtime.inspectSession(first.sessionId)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
        expect(trace.launches).toHaveLength(2);
        expect(await runtime.inspectSession(second.sessionId)).toEqual(second);
    });

    it('leaves an existing lock owner untouched and cleans up a failed launch', async () => {
        const owner = { token: 'owner-token', closed: false };
        locks.acquire.mockImplementation(() => {
            throw new Error(`profile.lock held by pid 4242 cookie=${owner.token}`);
        });
        const runtime = createAgentRuntime();
        active = runtime;
        await expect(runtime.start()).rejects.toMatchObject({
            code: 'LOCK_HELD',
            message: 'Profile lock is held.',
        });
        expect(trace.launches).toHaveLength(0);
        expect(locks.release).not.toHaveBeenCalled();
        expect(owner.closed).toBe(false);
        expect(events).toEqual([]);

        locks.acquire.mockImplementation((dir) => ({ pid: 7, token: 'tok-fail', path: join(dir, 'profile.lock') }));
        trace.launchImpl = async () => {
            throw new Error('cookie=super-secret-cookie-value https://evil.example/private?token=sekret --user-data-dir=/tmp/secret-profile');
        };
        const failed = await runtime.start().catch((error) => error);
        expect(failed.code).toBe('STARTUP_FAILED');
        expect(failed.message).toBe('Browser launch failed.');
        expect(String(failed.message)).not.toMatch(/super-secret-cookie-value|evil\.example|secret-profile/);
        expect(failed.cause).toBeUndefined();
        expect(locks.release).toHaveBeenCalledTimes(1);
        expect(locks.release).toHaveBeenCalledWith(workerDir(), 'tok-fail');
        expect(events).not.toContain('close');
        expect(trace.connectOverCDP).toBe(0);
    });

    it('does not enroll a page that is not about:blank', async () => {
        const made = makeContext(events);
        made.context.newPage = async () => {
            const page = makePage('foreign-target', 'https://evil.example/private');
            made.order.push(page);
            return page;
        };
        trace.launchImpl = () => made.context;
        const runtime = createAgentRuntime();
        active = runtime;
        await runtime.start();
        await expect(runtime.openSession()).rejects.toMatchObject({ code: 'SESSION_CLOSED' });
        expect(made.order[0].closed).toBe(true);
        expect(made.order[0].cdpAttached).toBe(0);
    });

    it('turns a secret-bearing page creation failure into a stable code', async () => {
        const made = makeContext(events);
        const secret = 'super-secret-cookie-value https://evil.example/private?token=sekret';
        made.context.newPage = async () => {
            const error = new Error(`Playwright newPage failed ${secret} --user-data-dir=/tmp/secret-profile`);
            error.stack = `${error.message}\n    at newPage (/tmp/secret-profile/playwright.js:1:1)`;
            throw error;
        };
        trace.launchImpl = () => made.context;
        const runtime = createAgentRuntime();
        active = runtime;
        await runtime.start();
        const error = await runtime.openSession().catch((caught) => caught);
        expect(error).toMatchObject({ code: 'SESSION_CLOSED', message: 'Session target is closed.' });
        expect(error.cause).toBeUndefined();
        expect(`${error.message}\n${error.stack}`).not.toMatch(/super-secret-cookie-value|evil\.example|secret-profile|Playwright/);
        await expect(runtime.inspectSession('ses_missing')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
        expect(trace.launches).toHaveLength(1);
        expect(locks.release).not.toHaveBeenCalled();
    });

    it('keeps the profile lock when close fails and retries shutdown before restart', async () => {
        const made = makeContext(events);
        const secret = 'super-secret-cookie-value';
        let attempts = 0;
        const originalClose = made.context.close.bind(made.context);
        made.context.close = async () => {
            attempts += 1;
            if (attempts === 1) {
                const error = new Error(`browser still open cookie=${secret} https://evil.example/private`);
                error.stack = `${error.message}\n    at close (/tmp/secret-profile/playwright.js:4:1)`;
                throw error;
            }
            await originalClose();
        };
        trace.launchImpl = () => made.context;
        const runtime = createAgentRuntime();
        active = runtime;
        await runtime.start();
        const first = await runtime.openSession();
        const failed = await runtime.stop().catch((caught) => caught);
        expect(failed).toMatchObject({ code: 'SHUTDOWN_FAILED', message: 'Browser shutdown failed.' });
        expect(failed.cause).toBeUndefined();
        expect(`${failed.message}\n${failed.stack}`).not.toMatch(/super-secret-cookie-value|evil\.example|secret-profile/);
        expect(locks.release).not.toHaveBeenCalled();
        expect(events).not.toContain('close');
        expect(trace.launches).toHaveLength(1);
        await expect(runtime.start()).rejects.toMatchObject({ code: 'ALREADY_RUNNING' });
        expect(trace.launches).toHaveLength(1);
        expect(locks.acquire).toHaveBeenCalledTimes(1);

        await runtime.stop();
        expect(events).toEqual(['close', 'release']);
        expect(locks.release).toHaveBeenCalledTimes(1);
        expect(locks.release).toHaveBeenCalledWith(workerDir(), 'tok-1');

        const restarted = makeContext(events);
        trace.launchImpl = () => restarted.context;
        await runtime.start();
        const second = await runtime.openSession();
        expect(second.sessionId).not.toBe(first.sessionId);
        await expect(runtime.inspectSession(first.sessionId)).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
        expect(await runtime.inspectSession(second.sessionId)).toEqual(second);
        expect(trace.launches).toHaveLength(2);
    });

    it('installs context interception before any page and blocks service workers', async () => {
        const made = makeContext(events);
        trace.launchImpl = () => made.context;
        const runtime = createAgentRuntime();
        active = runtime;
        await runtime.start();
        expect(trace.launches[0].options.serviceWorkers).toBe('block');
        expect(made.context.installOrder).toEqual(['route', 'routeWebSocket', 'addInitScript']);
        expect(made.context.routes[0].pattern).toBe('**/*');
        const wsRoute = made.context.webSocketRoutes[0];
        expect(wsRoute.pattern(new URL('wss://evil.example/socket'))).toBe(true);
        expect(wsRoute.pattern(new URL('ws://search.naver.com/ws'))).toBe(true);
        const foreignSocket = await closeSocket(wsRoute.handler, 'wss://evil.example/socket');
        const allowedHostSocket = await closeSocket(wsRoute.handler, 'wss://search.naver.com/ws');
        expect(foreignSocket).toEqual({ closed: 1, connected: 0, code: 1008 });
        expect(allowedHostSocket).toEqual({ closed: 1, connected: 0, code: 1008 });
        expect(JSON.stringify(foreignSocket)).not.toContain('evil.example');
        await runtime.openSession();
        expect(made.context.installOrder).toEqual(['route', 'routeWebSocket', 'addInitScript', 'newPage']);
        expect(made.context.initScripts).toHaveLength(1);

        const handler = made.context.routes[0].handler;
        const allowed = 'https://search.naver.com/search.naver?where=web&query=widgets';
        const privateUrl = 'http://169.254.169.254/latest';

        /**
         * @param {ReturnType<typeof makeRoutedRequest>} request
         * @param {Array<{ status: number, headers?: Record<string, string> }>} responses
         */
        async function settle(request, responses) {
            /** @type {Array<Record<string, unknown>>} */
            const fetches = [];
            /** @type {string | null} */
            let aborted = null;
            /** @type {{ response?: { status: () => number } } | null} */
            let fulfilled = null;
            let continued = false;
            await handler({
                request: () => request,
                async abort(reason) { aborted = reason || 'aborted'; },
                async continue() { continued = true; },
                async fulfill(value) { fulfilled = value; },
                async fetch(options = {}) {
                    fetches.push(options);
                    const next = responses[fetches.length - 1];
                    if (!next) throw new Error('fetch past the allowed hop');
                    return {
                        status: () => next.status,
                        headers: () => next.headers || {},
                    };
                },
            });
            return { fetches, aborted, fulfilled, continued };
        }

        const prior = makeRoutedRequest(allowed);
        const chained = await settle(makeRoutedRequest(privateUrl, { redirectedFrom: () => prior }), []);
        expect(chained.aborted).toBe('blockedbyclient');
        expect(chained.fetches).toHaveLength(0);
        expect(chained.fulfilled).toBeNull();

        const earlierHop = await settle(makeRoutedRequest(allowed, {
            redirectedFrom: () => makeRoutedRequest(privateUrl),
        }), []);
        expect(earlierHop.aborted).toBe('blockedbyclient');
        expect(earlierHop.fetches).toHaveLength(0);

        const redirected = await settle(makeRoutedRequest(allowed), [
            { status: 302, headers: { location: privateUrl } },
        ]);
        expect(redirected.fetches).toEqual([{ maxRedirects: 0 }]);
        expect(redirected.aborted).toBe('blockedbyclient');
        expect(redirected.fulfilled).toBeNull();
        expect(JSON.stringify(redirected.fetches)).not.toContain('169.254.169.254');

        const posted = await settle(makeRoutedRequest(allowed, { method: 'POST' }), []);
        expect(posted.aborted).toBe('blockedbyclient');
        expect(posted.fetches).toHaveLength(0);

        const headed = await settle(makeRoutedRequest(allowed, { method: 'HEAD' }), []);
        expect(headed.aborted).toBe('blockedbyclient');
        expect(headed.fetches).toHaveLength(0);

        const ok = await settle(makeRoutedRequest(allowed), [{ status: 200 }]);
        expect(ok.aborted).toBeNull();
        expect(ok.fetches).toEqual([{ maxRedirects: 0 }]);
        expect(ok.fulfilled?.response?.status()).toBe(200);

        const nextUrl = 'https://search.naver.com/search.naver?where=web&query=next';
        const followed = await settle(makeRoutedRequest(allowed), [
            { status: 302, headers: { location: nextUrl } },
            { status: 200 },
        ]);
        expect(followed.aborted).toBeNull();
        expect(followed.fetches).toEqual([
            { maxRedirects: 0 },
            { url: nextUrl, method: 'GET', maxRedirects: 0 },
        ]);
        expect(followed.fulfilled?.response?.status()).toBe(200);

        const blank = await settle(makeRoutedRequest('about:blank'), []);
        expect(blank.continued).toBe(true);
        expect(blank.fetches).toHaveLength(0);
        expect(blank.aborted).toBeNull();

        const handshake = await settle(makeRoutedRequest('https://search.naver.com/search.naver', {
            navigation: false,
            resourceType: 'websocket',
        }), []);
        expect(handshake.aborted).toBe('blockedbyclient');
        expect(handshake.fetches).toHaveLength(0);
        expect(handshake.continued).toBe(false);

        const socketUrl = await settle(makeRoutedRequest('wss://evil.example/socket', { navigation: false }), []);
        expect(socketUrl.aborted).toBe('blockedbyclient');
        expect(socketUrl.fetches).toHaveLength(0);

        const priorSocket = makeRoutedRequest('https://ssl.pstatic.net/ws', {
            navigation: false,
            resourceType: 'websocket',
        });
        const afterSocket = await settle(makeRoutedRequest(allowed, { redirectedFrom: () => priorSocket }), []);
        expect(afterSocket.aborted).toBe('blockedbyclient');
        expect(afterSocket.fetches).toHaveLength(0);

        const firstDocument = bootEpochWatch(made.context.initScripts[0]);
        expect(firstDocument.epoch).toBe(1);
        firstDocument.observers[0].callback();
        expect(firstDocument.sandbox.__agbrowseDocumentEpoch).toBe(2);
        const nextDocument = bootEpochWatch(made.context.initScripts[0]);
        expect(nextDocument.epoch).toBe(1);
        expect(nextDocument.sandbox).not.toBe(firstDocument.sandbox);
    });

    it('allows the fixed account URL and same-site login redirects only during login status on that page', async () => {
        const made = makeContext(events);
        const pages = [makePage('login-status-one'), makePage('login-status-two')];
        let index = 0;
        made.context.newPage = async () => pages[index++];
        trace.launchImpl = () => made.context;
        const runtime = createAgentRuntime();
        active = runtime;
        await runtime.start();
        const first = await runtime.openSession();
        await runtime.openSession();
        const handler = made.context.routes[0].handler;
        const decisions = [];

        async function request(url, { page, method = 'GET', navigation = false, redirectedFrom, fetchResponses = [] } = {}) {
            const decision = { url, page: page.targetId, method, navigation, fetched: 0, aborted: false };
            const routedRequest = makeRoutedRequest(url, { page, method, navigation, redirectedFrom });
            const responses = [...fetchResponses];
            await handler({
                request: () => routedRequest,
                async abort() { decision.aborted = true; },
                async fetch() {
                    decision.fetched += 1;
                    return responses.shift() ?? { status: () => 200, headers: () => ({}) };
                },
                async fulfill() {},
                async continue() {},
            });
            decisions.push(decision);
            return decision;
        }

        let redirectTo = 'https://nid.naver.com/nidlogin.login';
        pages[0].goto = async (url) => {
            const initial = makeRoutedRequest(url, { page: pages[0], navigation: true });
            await request(url, {
                page: pages[0],
                navigation: true,
                fetchResponses: [
                    { status: () => 302, headers: () => ({ location: redirectTo }) },
                    { status: () => 200, headers: () => ({}) },
                ],
            });
            await request('https://ssl.pstatic.net/static/home.css', { page: pages[0] });
            await request('https://evil.example/pixel', { page: pages[0] });
            await request('https://www.naver.com/write', { page: pages[0], method: 'POST', navigation: true, redirectedFrom: () => initial });
            await request('https://www.naver.com/static/home.css', { page: pages[1] });
            await request('https://nid.naver.com/nidlogin.login', { page: pages[0], navigation: true, redirectedFrom: () => initial });
            await request('https://evil.example/redirected', { page: pages[0], navigation: true, redirectedFrom: () => initial });
            await request('https://www.naver.com/redirected/path', { page: pages[0], navigation: true, redirectedFrom: () => initial });
            pages[0].currentUrl = 'https://nid.naver.com/user2/help/myInfo';
        };
        pages[0].evaluate = async (fn) => {
            throw new Error(`page content must not be read for a recognized URL: ${fn.name}`);
        };

        const result = await runtime.dispatchRead('naver.login_status', { session_id: first.sessionId });
        expect(result).toEqual({ status: 'logged_out', evidence: 'redirect_login' });
        expect(pages[0].url()).toBe('https://nid.naver.com/user2/help/myInfo');
        expect(decisions.slice(0, 2).map(({ fetched, aborted }) => ({ fetched, aborted })))
            .toEqual([{ fetched: 2, aborted: false }, { fetched: 1, aborted: false }]);
        expect(decisions.slice(2, 5).every(({ fetched, aborted }) => fetched === 0 && aborted)).toBe(true);
        expect(decisions[5]).toMatchObject({ fetched: 1, aborted: false, url: 'https://nid.naver.com/nidlogin.login' });
        expect(decisions[6]).toMatchObject({ fetched: 0, aborted: true, url: 'https://evil.example/redirected' });
        expect(decisions[7]).toMatchObject({ fetched: 1, aborted: false, url: 'https://www.naver.com/redirected/path' });

        redirectTo = 'https://evil.example/redirected';
        expect(await runtime.dispatchRead('naver.login_status', { session_id: first.sessionId }))
            .toEqual({ status: 'unknown', evidence: 'none' });

        const afterCall = await request('https://www.naver.com/static/after.css', { page: pages[0] });
        expect(afterCall).toMatchObject({ fetched: 0, aborted: true });
        await expect(runtime.dispatchRead('naver.login_status', {
            session_id: first.sessionId, navigation_url: 'https://evil.example/',
        })).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
    });

    it('reinstalls the document watcher on each main-frame navigation', async () => {
        const made = makeContext(events);
        const main = { id: 'main' };
        const page = makePage('target-read');
        page.listeners = {};
        page.evaluations = [];
        page.mainFrame = () => main;
        page.on = (event, fn) => {
            if (event !== 'popup' && event !== 'framenavigated') throw new Error(`unexpected page event ${event}`);
            page.listeners[event] = fn;
        };
        page.route = async () => {
            throw new Error('page route must not be installed');
        };
        page.goto = async () => {
            page.currentUrl = 'https://search.naver.com/search.naver';
            await page.listeners.framenavigated(main);
            await page.listeners.framenavigated({ id: 'child' });
        };
        page.evaluate = async (fn) => {
            page.evaluations.push(fn.name || 'anonymous');
            if (fn.name === 'readListingFromDocument') {
                return {
                    blocked: false,
                    reason: null,
                    results: [{ rank: 1, title: 'Alpha', snippet: 'One', href: 'https://news.example/a', node_id: 'n_1' }],
                };
            }
            return 1;
        };
        page.title = async () => 'Listing';
        made.context.newPage = async () => {
            made.context.installOrder.push('newPage');
            made.order.push(page);
            return page;
        };
        trace.launchImpl = () => made.context;
        const runtime = createAgentRuntime();
        active = runtime;
        await runtime.start();
        const opened = await runtime.openSession();
        const listed = await runtime.dispatchRead('naver.search.list', {
            session_id: opened.sessionId,
            query: 'widgets',
        });
        expect(page.evaluations.filter((name) => name === 'installEpochWatch')).toEqual(['installEpochWatch']);
        expect(listed.results[0].node_id).toBe('n_1');
        expect(listed.document_epoch).toBeGreaterThan(1);
        expect(JSON.stringify(listed)).not.toContain('widgets');
        await page.listeners.framenavigated(main);
        expect(page.evaluations.filter((name) => name === 'installEpochWatch')).toEqual(['installEpochWatch', 'installEpochWatch']);
    });

    it('retries the watcher when the document element is missing and counts a restored mutation', async () => {
        const made = makeContext(events);
        trace.launchImpl = () => made.context;
        const runtime = createAgentRuntime();
        active = runtime;
        await runtime.start();
        const script = made.context.initScripts[0];
        /** @type {Array<{ callback: (records?: unknown[]) => void, target: unknown, options: Record<string, boolean> }>} */
        const observers = [];
        /** @type {Array<{ type: string, fn: () => void }>} */
        const listeners = [];
        const element = { id: 'root' };
        const sandbox = {
            observers,
            MutationObserver: class MutationObserver {
                /**
                 * @param {(records?: unknown[]) => void} callback
                 */
                constructor(callback) {
                    this.callback = callback;
                }
                /**
                 * @param {unknown} target
                 * @param {Record<string, boolean>} options
                 */
                observe(target, options) {
                    this.target = target;
                    this.options = options;
                    observers.push(this);
                }
            },
            document: {
                documentElement: null,
                /**
                 * @param {string} type
                 * @param {() => void} fn
                 */
                addEventListener(type, fn) {
                    listeners.push({ type, fn });
                },
            },
        };
        sandbox.globalThis = sandbox;
        createContext(sandbox);
        const firstEpoch = runInContext(`(${script})()`, sandbox);
        expect(firstEpoch).toBe(1);
        expect(sandbox.__agbrowseEpochWatch).toBeUndefined();
        expect(observers.map((observer) => observer.target)).toEqual([sandbox.document]);
        expect(observers[0].options).toMatchObject({
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
        });
        expect(listeners.map((listener) => listener.type)).toEqual(['DOMContentLoaded']);
        observers[0].callback([{ type: 'childList' }]);
        expect(sandbox.__agbrowseDocumentEpoch).toBe(2);

        sandbox.document.documentElement = element;
        const retried = runInContext(`(${script})()`, sandbox);
        expect(retried).toBe(2);
        expect(sandbox.__agbrowseEpochWatch).toBe(true);
        const attached = observers.find((observer) => observer.target === element);
        expect(attached).toBeTruthy();
        expect(attached.options.characterData).toBe(true);
        const beforeRestore = sandbox.__agbrowseDocumentEpoch;
        attached.callback([{ type: 'characterData' }]);
        attached.callback([{ type: 'characterData' }]);
        expect(sandbox.__agbrowseDocumentEpoch).toBe(beforeRestore + 2);
        listeners[0].fn();
        expect(sandbox.__agbrowseDocumentEpoch).toBe(beforeRestore + 2);
        expect(observers.filter((observer) => observer.target === element)).toHaveLength(1);
    });
});

/**
 * @param {string} url
 * @param {{ method?: string, navigation?: boolean, resourceType?: string, redirectedFrom?: () => unknown, page?: object }} [options]
 */
function makeRoutedRequest(url, options = {}) {
    const method = options.method || 'GET';
    const navigation = options.navigation !== false;
    const redirectedFrom = options.redirectedFrom || (() => null);
    const resourceType = options.resourceType || '';
    return {
        url: () => url,
        method: () => method,
        isNavigationRequest: () => navigation,
        redirectedFrom,
        resourceType: () => resourceType,
        ...(options.page ? { frame: () => ({ page: () => options.page, parentFrame: () => null }) } : {}),
    };
}

/**
 * @param {(ws: { url: () => string, close: (options?: { code?: number }) => Promise<void>, connectToServer: () => unknown, send: () => void }) => Promise<void>} handler
 * @param {string} url
 */
async function closeSocket(handler, url) {
    const record = { closed: 0, connected: 0, code: 0 };
    await handler({
        url: () => url,
        async close(options) {
            record.closed += 1;
            record.code = options && options.code ? options.code : 0;
        },
        connectToServer() {
            record.connected += 1;
            return {};
        },
        send() {
            throw new Error('websocket send');
        },
    });
    return record;
}

/**
 * @param {Function} script
 */
function bootEpochWatch(script) {
    /** @type {Array<{ callback: () => void }>} */
    const observers = [];
    const sandbox = {
        observers,
        MutationObserver: class MutationObserver {
            /**
             * @param {() => void} callback
             */
            constructor(callback) {
                this.callback = callback;
                observers.push(this);
            }
            observe() {}
        },
        document: { documentElement: {} },
    };
    sandbox.globalThis = sandbox;
    createContext(sandbox);
    const epoch = runInContext(`(${script})()`, sandbox);
    return { sandbox, epoch, observers };
}
