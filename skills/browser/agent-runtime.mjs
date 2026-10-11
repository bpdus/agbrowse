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
    };
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
    /** @type {Map<string, { page: import('playwright-core').Page, targetId: string }>} */
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
                state = 'running';
            } catch (error) {
                await discardLaunch();
                if (error instanceof AgentRuntimeError) throw error;
                throw new AgentRuntimeError('STARTUP_FAILED', 'Browser launch failed.');
            }
        });
    }

    async function openSession() {
        return enqueue(async () => {
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
                sessions.set(sessionId, { page, targetId });
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
        });
    }

    /**
     * @param {string} sessionId
     */
    async function inspectSession(sessionId) {
        return enqueue(async () => {
            assertRunning();
            const binding = sessions.get(sessionId);
            if (!binding) throw new AgentRuntimeError('SESSION_NOT_FOUND', 'Session was not found.');
            if (typeof binding.page.isClosed === 'function' && binding.page.isClosed()) {
                sessions.delete(sessionId);
                throw new AgentRuntimeError('SESSION_CLOSED', 'Session target is closed.');
            }
            return { sessionId, targetId: binding.targetId };
        });
    }

    /**
     * @param {string} sessionId
     */
    async function closeSession(sessionId) {
        return enqueue(async () => {
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

    return { start, openSession, inspectSession, closeSession, stop };
}
