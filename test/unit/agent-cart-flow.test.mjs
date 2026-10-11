import { chmodSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { createCartStore } from '../../skills/browser/agent-cart-store.mjs';
import { prepareCart, readCartFromDocument, readProductFromDocument, setCartQuantity, verifyCartResult } from '../../skills/browser/agent-naver-cart.mjs';
import { createFakeCartPort } from '../helpers/fake-cart-port.mjs';

const productHtml = readFileSync(fileURLToPath(new URL('../fixtures/agent-cart/product.html', import.meta.url)), 'utf8');
const cartHtml = readFileSync(fileURLToPath(new URL('../fixtures/agent-cart/cart.html', import.meta.url)), 'utf8');
const binding = {
    device_id: 'dev_flow', epoch: 1, mcp_session_id: `mcp_${'d'.repeat(16)}`,
    session_id: `ses_${'e'.repeat(16)}`, worker_id: `wrk_${'f'.repeat(16)}`,
    account_key: 'acct_profile', now: 5000,
};
const operationIntent = {
    intent_id: `ci_${'a'.repeat(24)}`, device_id: binding.device_id, epoch: binding.epoch,
    mcp_session_id: binding.mcp_session_id, session_id: binding.session_id,
    worker_id: binding.worker_id, account_key: binding.account_key,
    product_id: 'product-17', variant_id: 'variant-blue-small', option_ids: ['blue', 'small'],
    current_quantity: 2, target_quantity: 3, unit_price_krw: 12000,
    product_fingerprint: 'fp_product', cart_fingerprint: 'fp_cart', unrelated_lines_fingerprint: 'fp_other',
    layout_version: 'fixture-naver-cart-v1', dry_run: false, created_at: 5000, expires_at: 305000,
};

function fixtureState() {
    return {
        product: readProductFromDocument(new JSDOM(productHtml).window.document),
        cart: readCartFromDocument(new JSDOM(cartHtml).window.document),
    };
}

function storeDirectory() {
    const root = mkdtempSync(join(tmpdir(), 'agb-cart-flow-'));
    mkdirSync(join(root, 'store'), { mode: 0o700 });
    chmodSync(join(root, 'store'), 0o700);
    return root;
}

describe('agent cart fixture flow', () => {
    it('uses dry-run by default and leaves the in-memory page untouched', async () => {
        const { product, cart } = fixtureState();
        const port = createFakeCartPort({ product, cart });
        const prepared = prepareCart(product, cart, {
            option_ids: ['blue', 'small'], quantity: 3, expected_unit_price: 12000,
        }, binding);
        const result = await setCartQuantity(port, prepared.intent, { now: 5001 });
        expect(result).toMatchObject({
            status: 'DRY_RUN', site_changed: false, order_created: false,
            verification_basis: 'no_mutation_dispatched', line: { quantity: 3, unit_price_krw: 12000 },
        });
        expect(port.actions).toEqual([]);
        expect(port.cart.lines[0].quantity).toBe(2);
    });

    it('checks cart-only response and readback for an add while blocking all production dispatch', async () => {
        const { product, cart } = fixtureState();
        const prepared = prepareCart(product, cart, {
            option_ids: ['red', 'small'], quantity: 1, expected_unit_price: 12500, dry_run: false,
        }, binding);
        const port = createFakeCartPort({ product, cart });
        await expect(setCartQuantity(port, prepared.intent, { dry_run: false, now: 5001 }))
            .rejects.toMatchObject({ code: 'SITE_UNSUPPORTED' });
        expect(port.actions).toEqual([]);
        const response = port.simulateMutation({ product_id: 'product-17', variant_id: 'variant-red-small', quantity: 1 });
        const after = port.cart;
        expect(verifyCartResult(cart, after, response, prepared.intent)).toMatchObject({ verified: true, quantity: 1, no_order_created: true });
    });

    it('serializes concurrent duplicate claims and rejects changed content for the same key', async () => {
        const root = storeDirectory();
        try {
            const store = createCartStore({ directory: join(root, 'store'), now: () => 5000 });
            store.saveIntent(operationIntent);
            const request = {
                device_id: binding.device_id, account_key: binding.account_key,
                intent_id: operationIntent.intent_id, idempotency_key: 'fixture-write', request_digest: 'a'.repeat(64),
            };
            const claims = await Promise.all([Promise.resolve().then(() => store.claimOperation(request)), Promise.resolve().then(() => store.claimOperation(request))]);
            expect(claims.filter((claim) => claim.duplicate)).toHaveLength(1);
            expect(claims[0].operation.operation_id).toBe(claims[1].operation.operation_id);
            expect(() => store.claimOperation({ ...request, request_digest: 'b'.repeat(64) }))
                .toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
        } finally { rmSync(root, { recursive: true, force: true }); }
    });

    it('binds product and cart fingerprints so changed state requires new preparation', () => {
        const { product, cart } = fixtureState();
        const prepared = prepareCart(product, cart, {
            option_ids: ['blue', 'small'], quantity: 3, expected_unit_price: 12000,
        }, binding);
        const changedProduct = { ...product, variants: product.variants.map((variant) => ({
            ...variant,
            ...(variant.variant_id === 'variant-blue-small' ? { unit_price_krw: 13000 } : {}),
        })) };
        expect(() => prepareCart(changedProduct, cart, {
            option_ids: ['blue', 'small'], quantity: 3, expected_unit_price: 12000,
        }, binding)).toThrowError(expect.objectContaining({ code: 'PRICE_CHANGED' }));
        expect(prepared.intent.product_fingerprint).toBe(product.fingerprint);
        expect(prepared.intent.cart_fingerprint).toBe(cart.fingerprint);
    });
});
