import { chmodSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCartStore } from '../../skills/browser/agent-cart-store.mjs';

const roots = [];
function directory() {
    const root = mkdtempSync(join(tmpdir(), 'agb-cart-store-'));
    roots.push(root);
    const target = join(root, 'state');
    mkdirSync(target, { mode: 0o700 });
    chmodSync(target, 0o700);
    return target;
}

function makeIntent(now = 1000) {
    return {
        intent_id: `ci_${'a'.repeat(24)}`,
        device_id: 'dev_test',
        epoch: 2,
        mcp_session_id: `mcp_${'d'.repeat(16)}`,
        session_id: `ses_${'b'.repeat(16)}`,
        worker_id: `wrk_${'c'.repeat(16)}`,
        account_key: 'acct_worker',
        product_id: 'product-17',
        product_fingerprint: 'fp_product',
        variant_id: 'variant-blue-small',
        option_ids: ['blue', 'small'],
        current_quantity: 2,
        target_quantity: 3,
        unit_price_krw: 12000,
        layout_version: 'fixture-naver-cart-v1',
        cart_fingerprint: 'fp_cart',
        unrelated_lines_fingerprint: 'fp_other',
        dry_run: false,
        created_at: now,
        expires_at: now + 300000,
    };
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('agent cart store', () => {
    it('persists prepared bindings and durable idempotency results with owner-only files', () => {
        let now = 1000;
        const dir = directory();
        const store = createCartStore({ directory: dir, now: () => now });
        const intent = makeIntent(now);
        store.saveIntent(intent);
        expect(store.findIntent(intent.intent_id, intent)).toMatchObject({ intent_id: intent.intent_id, account_key: 'acct_worker' });
        const claim = store.claimOperation({
            device_id: intent.device_id, account_key: intent.account_key, intent_id: intent.intent_id,
            idempotency_key: 'write-1', request_digest: '1'.repeat(64),
        });
        expect(claim).toMatchObject({ duplicate: false, operation: { status: 'DISPATCHING' } });
        const repeated = store.claimOperation({
            device_id: intent.device_id, account_key: intent.account_key, intent_id: intent.intent_id,
            idempotency_key: 'write-1', request_digest: '1'.repeat(64),
        });
        expect(repeated).toMatchObject({ duplicate: true, operation: { operation_id: claim.operation.operation_id } });
        expect(() => store.claimOperation({
            device_id: intent.device_id, account_key: intent.account_key, intent_id: intent.intent_id,
            idempotency_key: 'write-1', request_digest: '2'.repeat(64),
        })).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
        const finished = store.finishOperation(claim.operation.operation_id, 'SUCCEEDED', {
            status: 'SUCCEEDED', quantity: 3, unit_price_krw: 12000, secret: 'canary-secret-value',
        });
        expect(finished.result).toEqual({ status: 'SUCCEEDED', quantity: 3, unit_price_krw: 12000 });
        expect(fs.statSync(join(dir, 'cart-state.json')).mode & 0o777).toBe(0o600);
        now += 1;
    });

    it('recovers persisted DISPATCHING as unknown and blocks new account writes after restart', () => {
        const dir = directory();
        const intent = makeIntent();
        const first = createCartStore({ directory: dir, now: () => 1000 });
        first.saveIntent(intent);
        const claim = first.claimOperation({
            device_id: intent.device_id, account_key: intent.account_key, intent_id: intent.intent_id,
            idempotency_key: 'lost-response', request_digest: '3'.repeat(64),
        });
        const restarted = createCartStore({ directory: dir, now: () => 1100 });
        expect(restarted.recoverInterruptedOperations()).toEqual([claim.operation.operation_id]);
        expect(() => restarted.claimOperation({
            device_id: intent.device_id, account_key: intent.account_key, intent_id: intent.intent_id,
            idempotency_key: 'next-write', request_digest: '4'.repeat(64),
        })).toThrowError(expect.objectContaining({ code: 'ACCOUNT_BLOCKED' }));
        expect(restarted.claimOperation({
            device_id: intent.device_id, account_key: intent.account_key, intent_id: intent.intent_id,
            idempotency_key: 'lost-response', request_digest: '3'.repeat(64),
        })).toMatchObject({ duplicate: true, operation: { status: 'OUTCOME_UNKNOWN' } });
    });

    it('expires intents and binds them to device, epoch, MCP/browser session, worker, and account', () => {
        const dir = directory();
        const store = createCartStore({ directory: dir, now: () => 1000 });
        const intent = makeIntent();
        store.saveIntent(intent);
        expect(() => store.findIntent(intent.intent_id, { ...intent, session_id: `ses_${'d'.repeat(16)}` }))
            .toThrowError(expect.objectContaining({ code: 'ACTION_DENIED' }));
        expect(() => store.findIntent(intent.intent_id, { ...intent, mcp_session_id: `mcp_${'e'.repeat(16)}` }))
            .toThrowError(expect.objectContaining({ code: 'ACTION_DENIED' }));
        const expired = createCartStore({ directory: dir, now: () => 301000 });
        expect(() => expired.findIntent(intent.intent_id, intent)).toThrowError(expect.objectContaining({ code: 'INTENT_EXPIRED' }));
    });

    it('fails closed on unsafe directory modes and atomic-write errors', () => {
        const unsafe = directory();
        chmodSync(unsafe, 0o755);
        expect(() => createCartStore({ directory: unsafe })).toThrowError(expect.objectContaining({ code: 'STATE_UNSAFE' }));

        const failing = directory();
        const fakeFs = { ...fs, renameSync() { const error = new Error('canary-secret-value'); error.code = 'EIO'; throw error; } };
        const store = createCartStore({ directory: failing, fs: fakeFs });
        expect(() => store.saveIntent(makeIntent())).toThrowError(expect.objectContaining({ code: 'STATE_UNSAFE' }));
    });

    it('rejects unrecognized intent fields and malformed persisted records without exposing their values', () => {
        const dir = directory();
        const store = createCartStore({ directory: dir, now: () => 1000 });
        expect(() => store.saveIntent({ ...makeIntent(), payload: 'canary-secret-value' }))
            .toThrowError(expect.objectContaining({ code: 'STATE_UNSAFE', message: 'Stored state is not safe to use.' }));

        store.saveIntent(makeIntent());
        const filename = join(dir, 'cart-state.json');
        const state = JSON.parse(fs.readFileSync(filename, 'utf8'));
        state.intents[0].payload = 'canary-secret-value';
        fs.writeFileSync(filename, JSON.stringify(state), { mode: 0o600 });
        chmodSync(filename, 0o600);
        expect(() => createCartStore({ directory: dir, now: () => 1000 }).findIntent(makeIntent().intent_id, makeIntent()))
            .toThrowError(expect.objectContaining({ code: 'STATE_UNSAFE' }));
    });
});
