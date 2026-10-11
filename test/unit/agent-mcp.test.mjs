import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { authError } from '../../skills/browser/agent-auth-store.mjs';
import { createGateway } from '../../skills/browser/agent-gateway.mjs';
import { MCP_PROTOCOL_VERSION, createMcpDispatcher } from '../../skills/browser/agent-mcp.mjs';

const TOKEN = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2ln';
const ACCEPT = 'application/json, text/event-stream';
const source = readFileSync(fileURLToPath(new URL('../../skills/browser/agent-mcp.mjs', import.meta.url)), 'utf8');

function fakeWorker() {
    const calls = [];
    let workerId = `wrk_${'ab'.repeat(8)}`;
    const sessions = new Map();
    let blocker = null;
    return {
        calls,
        setWorkerId(id) { workerId = id; },
        session(id) { return sessions.get(id); },
        blockNext(op) {
            let enter;
            let release;
            const entered = new Promise((resolve) => { enter = resolve; });
            const blocked = new Promise((resolve) => { release = resolve; });
            blocker = { op, enter, blocked };
            return { entered, release };
        },
        async call(op, payload) {
            calls.push({ op, payload });
            if (op === 'worker.hello') return { worker_id: workerId };
            if (blocker?.op === op) {
                const waiting = blocker;
                blocker = null;
                waiting.enter();
                await waiting.blocked;
            }
            if (op === 'browser.session.open') {
                const sessionId = `ses_${randomBytes(8).toString('hex')}`;
                sessions.set(sessionId, {
                    document_epoch: 1,
                    page: {
                        origin: 'https://search.naver.com',
                        url: 'https://search.naver.com/search.naver',
                        title: 'Listing canary-token-value',
                    },
                    results: [
                        { rank: 1, title: 'Alpha canary-password-value', snippet: 'one canary-otp-value', url: 'https://news.example/a?token=canary-token-value' },
                        { rank: 2, title: 'Beta', snippet: 'two', url: 'https://news.example/b' },
                    ],
                });
                return { session_id: sessionId, tab_id: 'tab-1', frame_id: 'frame_main', document_epoch: 1 };
            }
            if (op === 'browser.session.close') return { closed: true };
            if (op === 'naver.login_status') return { status: 'logged_out', evidence: 'login_link' };
            const state = sessions.get(payload.session_id);
            if (!state) {
                const error = new Error('super-secret-cookie-value');
                error.code = 'SESSION_NOT_FOUND';
                throw error;
            }
            if (state.boom) {
                const error = new Error('super-secret-cookie-value');
                throw error;
            }
            if (op.startsWith('naver.cart.') || op === 'naver.product.read') {
                return { status: 'DRY_RUN', site_changed: false, order_created: false, verification_basis: 'no_mutation_dispatched' };
            }
            return {
                session_id: payload.session_id,
                tab_id: 'tab-1',
                frame_id: 'frame_main',
                document_epoch: state.document_epoch,
                page: state.page,
                results: state.results,
            };
        },
    };
}

function toolCall(id, name, arguments_) {
    return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } };
}

async function handle(mcp, body, { auth, headers = {}, method = 'POST', readBody } = {}) {
    let bodyRead = false;
    return mcp.handle({
        method,
        headers: {
            authorization: `Bearer ${TOKEN}`,
            'content-type': 'application/json',
            accept: ACCEPT,
            ...headers,
        },
        readBody: readBody || (async () => {
            bodyRead = true;
            return Buffer.from(JSON.stringify(body ?? {}));
        }),
        authenticate: auth || (async () => ({ device_id: 'dev_a', epoch: 1, scopes: ['browser:read'] })),
        bodyRead: () => bodyRead,
    });
}

async function startedSession() {
    const logs = [];
    const worker = fakeWorker();
    const mcp = createMcpDispatcher({ worker, log: (line) => logs.push(line) });
    const init = await handle(mcp, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    });
    const session = init.headers['mcp-session-id'];
    const headers = { 'mcp-session-id': session, 'mcp-protocol-version': MCP_PROTOCOL_VERSION };
    await handle(mcp, { jsonrpc: '2.0', method: 'notifications/initialized' }, { headers });
    const opened = await handle(mcp, toolCall(2, 'browser.session.open', {
        protocol_version: '0.1.0',
        request_id: 'req_open',
    }), { headers });
    return {
        logs,
        worker,
        mcp,
        headers,
        sessionId: opened.body.result.structuredContent.session_id,
    };
}

describe('agent mcp dispatcher', () => {
    it('rejects auth, scope, version, and schema failures before the worker tool', async () => {
        const worker = fakeWorker();
        const logs = [];
        const mcp = createMcpDispatcher({ worker, log: (line) => logs.push(line) });
        const missing = await mcp.handle({
            method: 'POST',
            headers: {},
            readBody: async () => { throw new Error('body was read'); },
            authenticate: async () => { throw new Error('auth was called'); },
        });
        expect(missing.status).toBe(401);
        expect(missing.body.error.code).toBe('AUTH_INVALID');

        const expired = await handle(mcp, {}, {
            auth: async () => { throw authError('AUTH_EXPIRED'); },
            readBody: async () => { throw new Error('body was read'); },
        });
        expect(expired.status).toBe(401);
        expect(expired.body.error.code).toBe('AUTH_EXPIRED');

        const revoked = await handle(mcp, {}, {
            auth: async () => { throw authError('DEVICE_REVOKED'); },
            readBody: async () => { throw new Error('body was read'); },
        });
        expect(revoked.status).toBe(401);
        expect(revoked.body.error.code).toBe('DEVICE_REVOKED');

        const denied = await handle(mcp, {}, {
            auth: async () => ({ device_id: 'dev_a', epoch: 1, scopes: ['browser:inspect'] }),
            readBody: async () => { throw new Error('body was read'); },
        });
        expect(denied.status).toBe(403);
        expect(denied.body.error.code).toBe('SCOPE_DENIED');

        const version = await handle(mcp, {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2024-11-05', capabilities: {} },
        });
        expect(version.status).toBe(400);
        expect(version.body.error.data.code).toBe('VERSION_UNSUPPORTED');
        expect(version.headers['mcp-session-id']).toBeUndefined();

        const init = await handle(mcp, {
            jsonrpc: '2.0',
            id: 2,
            method: 'initialize',
            params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '0' } },
        });
        const extra = await handle(mcp, toolCall(3, 'browser.session.open', {
            protocol_version: '0.1.0',
            request_id: 'req_bad',
            url: 'https://evil.example',
            device_id: 'dev_other',
        }), {
            headers: {
                'mcp-session-id': init.headers['mcp-session-id'],
                'mcp-protocol-version': MCP_PROTOCOL_VERSION,
            },
        });
        expect(extra.status).toBe(200);
        expect(extra.body.result.isError).toBe(true);
        expect(extra.body.result.structuredContent.error.code).toBe('INVALID_ARGUMENTS');
        expect(worker.calls).toEqual([]);
        expect(logs.join('')).not.toMatch(/evil\.example|dev_other|eyJhbGci/);
        expect(source).not.toMatch(/\.click\(|\.fill\(|\.press\(|\.type\(|setInputFiles|playwright/);
    });

    it('lists login status and keeps cart read and write scopes separate', async () => {
        const ctx = await startedSession();
        const before = ctx.worker.calls.length;
        const list = await handle(ctx.mcp, { jsonrpc: '2.0', id: 90, method: 'tools/list' }, { headers: ctx.headers });
        const tools = list.body.result.tools;
        expect(tools.some((tool) => tool.name === 'operator.naver.topbar_structure')).toBe(false);
        const loginStatus = tools.find((tool) => tool.name === 'naver.login_status');
        expect(loginStatus.inputSchema.required).toEqual(['protocol_version', 'request_id', 'session_id']);
        expect(loginStatus.inputSchema.additionalProperties).toBe(false);
        expect(loginStatus.description).toContain('browser:read');
        expect(tools.map((tool) => tool.name).filter((name) => name.startsWith('naver.cart.') || name === 'naver.product.read')).toEqual([
            'naver.product.read', 'naver.cart.read', 'naver.cart.prepare', 'naver.cart.set',
        ]);
        expect(tools.filter((tool) => tool.name.startsWith('naver.cart.')).every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);

        const login = await handle(ctx.mcp, toolCall(91, 'naver.login_status', {
            protocol_version: '0.1.0', request_id: 'req_login_status', session_id: ctx.sessionId,
        }), { headers: ctx.headers });
        expect(login.body.result.structuredContent).toEqual({ status: 'logged_out', evidence: 'login_link' });
        expect(login.body.result.content[0].text).toBe('{"status":"logged_out","evidence":"login_link"}');
        expect(ctx.worker.calls.at(-1)).toEqual({ op: 'naver.login_status', payload: { session_id: ctx.sessionId } });
        expect(JSON.stringify(login.body)).not.toMatch(/Fixture Private Name|example\.test|nidlogin|url=/i);

        const callCountBeforeOperator = ctx.worker.calls.length;
        const operator = await handle(ctx.mcp, toolCall(97, 'operator.naver.topbar_structure', {
            protocol_version: '0.1.0', request_id: 'req_operator_capture',
        }), { headers: ctx.headers });
        expect(operator.status).toBe(400);
        expect(operator.body.error.code).toBe(-32602);
        expect(ctx.worker.calls).toHaveLength(callCountBeforeOperator);

        const cartRead = await handle(ctx.mcp, toolCall(92, 'naver.cart.read', {
            protocol_version: '0.1.0', request_id: 'req_cart_read', session_id: ctx.sessionId,
        }), { headers: ctx.headers });
        const productRead = await handle(ctx.mcp, toolCall(93, 'naver.product.read', {
            protocol_version: '0.1.0', request_id: 'req_product_read', session_id: ctx.sessionId,
        }), { headers: ctx.headers });
        expect(cartRead.body.result.isError).toBe(false);
        expect(productRead.body.result.isError).toBe(false);

        const denied = await handle(ctx.mcp, toolCall(94, 'naver.cart.prepare', {
            protocol_version: '0.1.0', request_id: 'req_cart_denied', session_id: ctx.sessionId,
            product_ref: `pref_${'1'.repeat(24)}`, option_ids: ['blue'], quantity: 1, expected_unit_price: 12000,
        }), { headers: ctx.headers });
        expect(denied.status).toBe(403);
        expect(denied.body.error.code).toBe('SCOPE_DENIED');
        expect(ctx.worker.calls.slice(before).some((call) => call.op === 'naver.cart.prepare')).toBe(false);

        const deniedSet = await handle(ctx.mcp, toolCall(95, 'naver.cart.set', {
            protocol_version: '0.1.0', request_id: 'req_cart_set_denied', session_id: ctx.sessionId,
            intent_id: `ci_${'2'.repeat(24)}`, idempotency_key: 'denied-1',
        }), { headers: ctx.headers });
        expect(deniedSet.status).toBe(403);
        expect(deniedSet.body.error.code).toBe('SCOPE_DENIED');

        const allowed = await handle(ctx.mcp, toolCall(96, 'naver.cart.set', {
            protocol_version: '0.1.0', request_id: 'req_cart_dry', session_id: ctx.sessionId,
            intent_id: `ci_${'1'.repeat(24)}`, idempotency_key: 'dry-1',
        }), {
            headers: ctx.headers,
            auth: async () => ({ device_id: 'dev_a', epoch: 1, scopes: ['browser:read', 'cart:write'] }),
        });
        expect(allowed.body.result.isError).toBe(false);
        expect(allowed.body.result.structuredContent).toMatchObject({ status: 'DRY_RUN', site_changed: false, order_created: false });
        expect(ctx.worker.calls.at(-1)).toMatchObject({ op: 'naver.cart.set', payload: { dry_run: true, device_id: 'dev_a', epoch: 1 } });
        expect(ctx.logs.join('')).not.toContain('req_cart_dry');
        expect(ctx.logs.join('')).toMatch(/correlation=[a-f0-9]{16}/);
    });

    it('rechecks cart scopes after a session-queue wait and stops before worker dispatch', async () => {
        const ctx = await startedSession();
        const blocker = ctx.worker.blockNext('browser.observe');
        let scopesGranted = true;
        let authCalls = 0;
        const auth = async () => {
            authCalls += 1;
            return { device_id: 'dev_a', epoch: 1, scopes: scopesGranted ? ['browser:read', 'cart:write'] : ['browser:read'] };
        };
        const observing = handle(ctx.mcp, toolCall(93, 'browser.observe', {
            protocol_version: '0.1.0', request_id: 'req_obs_queue', session_id: ctx.sessionId,
        }), { headers: ctx.headers, auth });
        await blocker.entered;
        const cartCallStart = ctx.worker.calls.length;
        const cartPending = handle(ctx.mcp, toolCall(94, 'naver.cart.prepare', {
            protocol_version: '0.1.0', request_id: 'req_cart_queued', session_id: ctx.sessionId,
            product_ref: `pref_${'1'.repeat(24)}`, option_ids: ['blue'], quantity: 1, expected_unit_price: 12000,
        }), { headers: ctx.headers, auth });
        while (authCalls < 3) await new Promise((resolve) => setImmediate(resolve));
        scopesGranted = false;
        blocker.release();
        await observing;
        const denied = await cartPending;
        expect(denied.status).toBe(403);
        expect(denied.body.error.code).toBe('SCOPE_DENIED');
        expect(ctx.worker.calls.slice(cartCallStart).some((call) => call.op === 'naver.cart.prepare')).toBe(false);
    });

    it('redacts listing output and rejects stale, cross-session, and restarted reads', async () => {
        const ctx = await startedSession();
        const listed = await handle(ctx.mcp, toolCall(4, 'naver.search.list', {
            protocol_version: '0.1.0',
            request_id: 'req_list',
            session_id: ctx.sessionId,
            query: 'canary-password-value',
        }), { headers: ctx.headers });
        const snap = listed.body.result.structuredContent;
        expect(listed.body.result.isError).toBe(false);
        expect(snap.kind).toBe('full');
        expect(snap.base_snapshot_id).toBeNull();
        expect(snap.nodes[0].allowed_actions).toEqual(['naver.search.result.read']);
        const body = JSON.stringify(listed.body);
        expect(body).not.toMatch(/canary-password-value|canary-token-value|canary-otp-value/);
        expect(ctx.logs.join('')).not.toContain('canary-password-value');

        const ref = snap.nodes[0].ref;
        const read = await handle(ctx.mcp, toolCall(5, 'naver.search.result.read', {
            protocol_version: '0.1.0',
            request_id: 'req_read',
            session_id: ctx.sessionId,
            ref,
        }), { headers: ctx.headers });
        expect(read.body.result.isError).toBe(false);
        expect(JSON.stringify(read.body)).not.toMatch(/canary-password-value|canary-token-value/);

        const state = ctx.worker.session(ctx.sessionId);
        state.document_epoch = 2;
        state.results = [{ rank: 1, title: 'SubstitutedTitle', snippet: 'changed', url: 'https://news.example/z' }];
        const changed = await handle(ctx.mcp, toolCall(6, 'naver.search.result.read', {
            protocol_version: '0.1.0',
            request_id: 'req_changed',
            session_id: ctx.sessionId,
            ref,
        }), { headers: ctx.headers });
        expect(changed.body.result.structuredContent.error.code).toBe('STATE_CHANGED');
        expect(JSON.stringify(changed.body)).not.toContain('SubstitutedTitle');

        state.document_epoch = 2;
        state.results = [{ rank: 1, title: 'Alpha canary-password-value', snippet: 'one canary-otp-value', url: 'https://news.example/a?token=canary-token-value' }];
        const observed = await handle(ctx.mcp, toolCall(7, 'browser.observe', {
            protocol_version: '0.1.0',
            request_id: 'req_obs',
            session_id: ctx.sessionId,
            base_snapshot_id: snap.snapshot_id,
        }), { headers: ctx.headers });
        expect(observed.body.result.structuredContent.kind).toBe('full');
        const before = ctx.worker.calls.length;
        const stale = await handle(ctx.mcp, toolCall(8, 'naver.search.result.read', {
            protocol_version: '0.1.0',
            request_id: 'req_stale',
            session_id: ctx.sessionId,
            ref,
        }), { headers: ctx.headers });
        expect(stale.body.result.structuredContent.error.code).toBe('STALE_REF');
        expect(ctx.worker.calls.slice(before).map((call) => call.op)).toEqual([]);

        const other = await handle(ctx.mcp, toolCall(9, 'browser.session.open', {
            protocol_version: '0.1.0',
            request_id: 'req_open_b',
        }), { headers: ctx.headers });
        const otherId = other.body.result.structuredContent.session_id;
        const freshRef = observed.body.result.structuredContent.nodes[0].ref;
        const crossAt = ctx.worker.calls.length;
        const crossed = await handle(ctx.mcp, toolCall(10, 'naver.search.result.read', {
            protocol_version: '0.1.0',
            request_id: 'req_cross',
            session_id: otherId,
            ref: freshRef,
        }), { headers: ctx.headers });
        expect(crossed.body.result.isError).toBe(true);
        expect(crossed.body.result.structuredContent.error.code).toBe('ACTION_DENIED');
        expect(ctx.worker.calls.slice(crossAt)).toEqual([]);

        const marker = ctx.worker.calls.length;
        const foreign = await handle(ctx.mcp, toolCall(11, 'naver.search.result.read', {
            protocol_version: '0.1.0',
            request_id: 'req_foreign',
            session_id: ctx.sessionId,
            ref: freshRef,
        }), {
            headers: ctx.headers,
            auth: async () => ({ device_id: 'dev_b', epoch: 1, scopes: ['browser:read'] }),
        });
        expect(foreign.status).toBe(403);
        expect(foreign.body.error.code).toBe('ACTION_DENIED');
        expect(ctx.worker.calls.slice(marker)).toEqual([]);

        const restartAt = ctx.worker.calls.length;
        ctx.worker.setWorkerId(`wrk_${'ff'.repeat(8)}`);
        const restarted = await handle(ctx.mcp, toolCall(12, 'naver.search.list', {
            protocol_version: '0.1.0',
            request_id: 'req_restart',
            session_id: ctx.sessionId,
            query: 'widgets',
        }), { headers: ctx.headers });
        expect(restarted.body.result.structuredContent.error.code).toBe('NOT_RUNNING');
        expect(ctx.worker.calls.slice(restartAt).map((call) => call.op)).toEqual(['worker.hello']);
        expect(ctx.logs.join('')).not.toMatch(/widgets|SubstitutedTitle|canary-secret-value|super-secret-cookie-value/);
    });

    it('serves authenticated /mcp through the gateway and stops bad calls at the door', async () => {
        const worker = fakeWorker();
        const logs = [];
        const gateway = createGateway({
            auth: {
                async submitPairing() { return {}; },
                async issueChallenge() { return {}; },
                async exchangeProof() { return {}; },
                async authenticate(token) {
                    if (token.endsWith('.expired')) throw authError('AUTH_EXPIRED');
                    return { device_id: 'dev_a', epoch: 1, scopes: ['browser:read'] };
                },
            },
            worker,
            port: 0,
            allowedHosts: ['127.0.0.1:0'],
            log: (line) => logs.push(line),
        });
        await gateway.start();
        try {
            const bound = gateway.address();
            const host = `127.0.0.1:${bound.port}`;
            const denied = await request(bound.port, { path: '/mcp', method: 'POST', headers: { host } });
            expect(denied.status).toBe(401);
            expect(JSON.parse(denied.body).error.code).toBe('AUTH_INVALID');
            expect(worker.calls).toEqual([]);

            const expired = await request(bound.port, {
                path: '/mcp',
                method: 'POST',
                headers: { host, authorization: 'Bearer eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.expired' },
            });
            expect(expired.status).toBe(401);
            expect(JSON.parse(expired.body).error.code).toBe('AUTH_EXPIRED');
            expect(worker.calls).toEqual([]);

            const initBody = JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'gw', version: '0' } },
            });
            const init = await request(bound.port, {
                path: '/mcp',
                method: 'POST',
                headers: {
                    host,
                    authorization: `Bearer ${TOKEN}`,
                    'content-type': 'application/json',
                    accept: ACCEPT,
                    'content-length': Buffer.byteLength(initBody),
                },
                body: initBody,
            });
            expect(init.status).toBe(200);
            expect(init.headers['mcp-protocol-version']).toBe(MCP_PROTOCOL_VERSION);
            expect(init.headers['mcp-session-id']).toMatch(/^mcp_[a-f0-9]{16}$/);
            expect(worker.calls).toEqual([]);

            const operatorBody = JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: {
                    name: 'operator.naver.topbar_structure',
                    arguments: { protocol_version: '0.1.0', request_id: 'req_operator_capture' },
                },
            });
            const operator = await request(bound.port, {
                path: '/mcp',
                method: 'POST',
                headers: {
                    host,
                    authorization: `Bearer ${TOKEN}`,
                    'content-type': 'application/json',
                    accept: ACCEPT,
                    'content-length': Buffer.byteLength(operatorBody),
                    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
                    'mcp-session-id': init.headers['mcp-session-id'],
                },
                body: operatorBody,
            });
            expect(operator.status).toBe(400);
            expect(JSON.parse(operator.body).error.code).toBe(-32602);
            expect(worker.calls).toEqual([]);
            expect(logs.join('')).not.toContain(TOKEN);
        } finally {
            await gateway.stop();
        }
    });
});

function request(port, { path = '/mcp', method = 'GET', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('error', reject);
        req.end(body);
    });
}
