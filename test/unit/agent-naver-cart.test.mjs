import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
    CART_FIXTURE_LAYOUT,
    classifyCartRequest,
    fingerprintCartState,
    prepareCart,
    readCartFromDocument,
    readProductFromDocument,
    resolveVariant,
    setCartQuantity,
    verifyCartResult,
} from '../../skills/browser/agent-naver-cart.mjs';
import { createFakeCartPort } from '../helpers/fake-cart-port.mjs';

const productHtml = readFileSync(fileURLToPath(new URL('../fixtures/agent-cart/product.html', import.meta.url)), 'utf8');
const cartHtml = readFileSync(fileURLToPath(new URL('../fixtures/agent-cart/cart.html', import.meta.url)), 'utf8');
const binding = { device_id: 'dev_test', epoch: 2, mcp_session_id: `mcp_${'c'.repeat(16)}`, session_id: `ses_${'a'.repeat(16)}`, worker_id: `wrk_${'b'.repeat(16)}`, account_key: 'acct_worker', now: 1000 };

function product() { return readProductFromDocument(new JSDOM(productHtml).window.document); }
function cart() { return readCartFromDocument(new JSDOM(cartHtml).window.document); }

describe('agent naver cart fixture adapter', () => {
    it('reads only the explicit fixture layout and resolves an exact option combination', () => {
        const parsed = product();
        expect(parsed.supported).toBe(true);
        expect(parsed.layout_version).toBe(CART_FIXTURE_LAYOUT);
        expect(parsed.product_id).toBe('product-17');
        expect(resolveVariant(parsed, ['blue', 'small'])).toMatchObject({ variant_id: 'variant-blue-small', unit_price_krw: 12000 });
        expect(() => resolveVariant(parsed, ['small', 'blue'])).toThrowError(expect.objectContaining({ code: 'OPTION_INVALID' }));
        expect(() => resolveVariant(parsed, ['green'])).toThrowError(expect.objectContaining({ code: 'OPTION_INVALID' }));
    });

    it('fails closed on unknown layouts and keeps opaque refs out of stable fingerprints', () => {
        const unknown = new JSDOM('<main data-product-id="real-looking"></main>').window.document;
        expect(readProductFromDocument(unknown)).toMatchObject({ supported: false, reason: 'SITE_UNSUPPORTED' });
        expect(readCartFromDocument(unknown)).toMatchObject({ supported: false, reason: 'SITE_UNSUPPORTED' });

        const first = cart();
        const second = cart();
        expect(first.lines[0].line_ref).not.toBe(second.lines[0].line_ref);
        expect(first.fingerprint).toBe(second.fingerprint);
        expect(fingerprintCartState({ b: 2, a: 1 })).toBe(fingerprintCartState({ a: 1, b: 2 }));
    });

    it('rejects invalid quantities, unavailable stock, subscriptions, custom options, and changed prices', () => {
        const parsed = product();
        const current = cart();
        expect(() => prepareCart(parsed, current, { option_ids: ['blue', 'small'], quantity: 0, expected_unit_price: 12000 }, binding))
            .toThrowError(expect.objectContaining({ code: 'QUANTITY_INVALID' }));
        expect(() => prepareCart(parsed, current, { option_ids: ['blue', 'large'], quantity: 1, expected_unit_price: 14000 }, binding))
            .toThrowError(expect.objectContaining({ code: 'OUT_OF_STOCK' }));
        expect(() => prepareCart(parsed, current, { option_ids: ['blue', 'small'], quantity: 1, expected_unit_price: 1 }, binding))
            .toThrowError(expect.objectContaining({ code: 'PRICE_CHANGED' }));
        const subscription = new JSDOM(productHtml.replace('data-fixture-product-name="Fixture mug"', 'data-fixture-product-name="Fixture mug" data-fixture-subscription="true"')).window.document;
        expect(readProductFromDocument(subscription).reason).toBe('SITE_UNSUPPORTED');
        const custom = new JSDOM(productHtml.replace('data-fixture-stock="6"', 'data-fixture-stock="6" data-fixture-custom-option="true"')).window.document;
        expect(readProductFromDocument(custom).reason).toBe('SITE_UNSUPPORTED');
    });

    it('prepares absolute target quantities and dry-runs without dispatching an action', async () => {
        const parsedProduct = product();
        const parsedCart = cart();
        const prepared = prepareCart(parsedProduct, parsedCart, {
            option_ids: ['blue', 'small'], quantity: 3, expected_unit_price: 12000,
        }, binding);
        expect(prepared).toMatchObject({ current_quantity: 2, target_quantity: 3, predicted_change: 'update', unit_price_krw: 12000 });
        expect(prepared.intent.expires_at).toBe(301000);
        const port = createFakeCartPort({ product: parsedProduct, cart: parsedCart });
        const result = await setCartQuantity(port, prepared.intent, { dry_run: true, now: 1001 });
        expect(result).toMatchObject({ status: 'DRY_RUN', site_changed: false, order_created: false, verification_basis: 'no_mutation_dispatched' });
        expect(port.actions).toEqual([]);
    });

    it('keeps explicit live execution fail-closed, including an intent prepared for live use', async () => {
        const parsedProduct = product();
        const parsedCart = cart();
        const prepared = prepareCart(parsedProduct, parsedCart, {
            option_ids: ['blue', 'small'], quantity: 3, expected_unit_price: 12000, dry_run: false,
        }, binding);
        const port = createFakeCartPort({ product: parsedProduct, cart: parsedCart });
        const safeDefault = await setCartQuantity(port, prepared.intent, { now: 1001 });
        expect(safeDefault.status).toBe('DRY_RUN');
        expect(port.actions).toEqual([]);
        await expect(setCartQuantity(port, prepared.intent, { dry_run: false, now: 1001 }))
            .rejects.toMatchObject({ code: 'SITE_UNSUPPORTED' });
        expect(port.actions).toEqual([]);
    });

    it('confirms exact add/update readback and rejects order responses or changed unrelated lines', () => {
        const parsedProduct = product();
        const parsedCart = cart();
        const prepared = prepareCart(parsedProduct, parsedCart, {
            option_ids: ['red', 'small'], quantity: 1, expected_unit_price: 12500,
        }, binding);
        const port = createFakeCartPort({ product: parsedProduct, cart: parsedCart });
        const response = port.simulateMutation({ product_id: 'product-17', variant_id: 'variant-red-small', quantity: 1 });
        const after = port.cart;
        after.fingerprint = fingerprintCartState(after.lines);
        expect(verifyCartResult(parsedCart, after, response, prepared.intent)).toMatchObject({
            verified: true, quantity: 1, unit_price_krw: 12500, no_order_created: true,
        });
        expect(() => verifyCartResult(parsedCart, after, { kind: 'order', order_created: true }, prepared.intent))
            .toThrowError(expect.objectContaining({ code: 'ORDER_CREATION_DETECTED' }));
        const changed = { ...after, lines: [...after.lines, { line_id: 'other-new', product_id: 'other', variant_id: 'v', quantity: 1, unit_price_krw: 1 }] };
        expect(() => verifyCartResult(parsedCart, changed, response, prepared.intent))
            .toThrowError(expect.objectContaining({ code: 'CART_CONFIRMATION_FAILED' }));
    });

    it('allows only one exact worker permit and blocks checkout, broad writes, and replay', () => {
        let consumed = false;
        const url = 'https://fixture.invalid/cart/mutate';
        const payload = { product_id: 'product-17', variant_id: 'variant-blue-small', quantity: 3 };
        const permit = { url, method: 'POST', payload, consume: () => { if (consumed) return false; consumed = true; return true; } };
        expect(classifyCartRequest({ url, method: 'POST', payload, permit })).toBe('allow-once');
        expect(classifyCartRequest({ url, method: 'POST', payload, permit })).toBe('deny');
        expect(classifyCartRequest({ url: 'https://fixture.invalid/checkout', method: 'POST', payload, permit })).toBe('deny');
        expect(classifyCartRequest({ url, method: 'POST', payload: { ...payload, quantity: 99 }, permit })).toBe('deny');
        expect(classifyCartRequest({ url, method: 'POST', payload })).toBe('deny');
    });

    it('classifies recognized login and human gates without reading credential values', () => {
        const login = new JSDOM('<form action="/login"><input type="password" value="canary-password-value"></form>').window.document;
        const captcha = new JSDOM('<div data-captcha></div>').window.document;
        expect(readProductFromDocument(login).reason).toBe('LOGIN_REQUIRED');
        expect(readCartFromDocument(captcha).reason).toBe('HUMAN_REQUIRED');
        expect(JSON.stringify(readProductFromDocument(login))).not.toContain('canary-password-value');
    });
});
