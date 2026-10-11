// @ts-check
/**
 * Fixture-contract cart adapter. The selectors below are deliberately marked
 * fixture-only: there is no sanitized live Naver layout evidence in this PR.
 * The production runtime therefore never enables its mutation capability.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readError } from './agent-read-error.mjs';

export const CART_FIXTURE_LAYOUT = 'fixture-naver-cart-v1';
export const CART_INTENT_TTL_MS = 5 * 60 * 1000;

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CHECKOUT_PATH = /(?:^|\/)(?:checkout|order|payment|pay)(?:\/|$)/i;
const VERIFIED_CART_PORTS = new WeakSet();

function normalizedText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function safeId(value) {
    return typeof value === 'string' && SAFE_ID.test(value) ? value : null;
}

function integerAttribute(element, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const raw = element.getAttribute(name);
    if (raw === null || !/^\d{1,12}$/.test(raw)) return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function layoutRoot(doc, selector) {
    const root = doc && typeof doc.querySelector === 'function' ? doc : globalThis.document;
    if (!root || typeof root.querySelector !== 'function') return { root: null, element: null };
    const blocked = root.querySelector('input[type="password"], form[action*="login" i], [data-login-form]');
    if (blocked) return { root, element: null, reason: 'LOGIN_REQUIRED' };
    const human = root.querySelector('#captcha, .captcha, [data-captcha], [data-agent-block]');
    if (human) return { root, element: null, reason: 'HUMAN_REQUIRED' };
    return { root, element: root.querySelector(selector) };
}

function parseOptionIds(raw) {
    let value;
    try {
        value = JSON.parse(raw ?? '');
    } catch {
        return null;
    }
    if (!Array.isArray(value) || value.length > 12 || !value.every((item) => safeId(item))) return null;
    return [...value];
}

function stableCartLines(lines) {
    return lines.map((line) => ({
        product_id: line.product_id,
        variant_id: line.variant_id,
        quantity: line.quantity,
        unit_price_krw: line.unit_price_krw,
    }));
}

/** Reads only the synthetic fixture layout; production compatibility is disabled in the runtime. */
export function readProductFromDocument(doc) {
    const { root, element, reason } = layoutRoot(doc, `[data-agent-fixture-cart-layout="${CART_FIXTURE_LAYOUT}"][data-fixture-product-id]`);
    if (reason) return { supported: false, reason, layout_version: null };
    if (!root || !element) return { supported: false, reason: 'SITE_UNSUPPORTED', layout_version: null };
    const productId = safeId(element.getAttribute('data-fixture-product-id'));
    const name = normalizedText(element.getAttribute('data-fixture-product-name'));
    if (!productId || !name || element.getAttribute('data-fixture-subscription') === 'true'
        || element.getAttribute('data-fixture-custom-option') === 'true') {
        return { supported: false, reason: 'SITE_UNSUPPORTED', layout_version: null };
    }
    const variants = [];
    for (const item of element.querySelectorAll('[data-fixture-variant-id]')) {
        if (item.getAttribute('data-fixture-subscription') === 'true' || item.getAttribute('data-fixture-custom-option') === 'true') {
            return { supported: false, reason: 'SITE_UNSUPPORTED', layout_version: null };
        }
        const variantId = safeId(item.getAttribute('data-fixture-variant-id'));
        const optionIds = parseOptionIds(item.getAttribute('data-fixture-option-ids'));
        const unitPrice = integerAttribute(item, 'data-fixture-price-krw');
        const stockLimit = integerAttribute(item, 'data-fixture-stock', { max: 999999 });
        if (!variantId || !optionIds || unitPrice === null || stockLimit === null) {
            return { supported: false, reason: 'SITE_UNSUPPORTED', layout_version: null };
        }
        variants.push({ variant_id: variantId, option_ids: optionIds, unit_price_krw: unitPrice, stock_limit: stockLimit });
    }
    if (!variants.length || new Set(variants.map((item) => item.variant_id)).size !== variants.length) {
        return { supported: false, reason: 'SITE_UNSUPPORTED', layout_version: null };
    }
    return {
        supported: true,
        reason: null,
        layout_version: CART_FIXTURE_LAYOUT,
        product_ref: `pref_${randomBytes(12).toString('hex')}`,
        product_id: productId,
        name,
        variants,
        fingerprint: fingerprintCartState({ product_id: productId, name, variants }),
    };
}

/** Reads cart lines from the synthetic fixture layout. */
export function readCartFromDocument(doc) {
    const { root, element, reason } = layoutRoot(doc, `[data-agent-fixture-cart-layout="${CART_FIXTURE_LAYOUT}"][data-fixture-cart-root]`);
    if (reason) return { supported: false, reason, layout_version: null, lines: [] };
    if (!root || !element) return { supported: false, reason: 'SITE_UNSUPPORTED', layout_version: null, lines: [] };
    const lines = [];
    for (const item of element.querySelectorAll('[data-fixture-cart-line-id]')) {
        const lineId = safeId(item.getAttribute('data-fixture-cart-line-id'));
        const productId = safeId(item.getAttribute('data-fixture-product-id'));
        const variantId = safeId(item.getAttribute('data-fixture-variant-id'));
        const quantity = integerAttribute(item, 'data-fixture-quantity', { min: 1, max: 99 });
        const unitPrice = integerAttribute(item, 'data-fixture-price-krw');
        if (!lineId || !productId || !variantId || quantity === null || unitPrice === null) {
            return { supported: false, reason: 'SITE_UNSUPPORTED', layout_version: null, lines: [] };
        }
        lines.push({ line_ref: `cl_${randomBytes(12).toString('hex')}`, product_id: productId, variant_id: variantId, quantity, unit_price_krw: unitPrice });
    }
    return {
        supported: true,
        reason: null,
        layout_version: CART_FIXTURE_LAYOUT,
        lines,
        fingerprint: fingerprintCartState(stableCartLines(lines)),
    };
}

/** @param {{ variants: Array<{ variant_id: string, option_ids: string[] }> } | null} product @param {unknown} optionIds */
export function resolveVariant(product, optionIds) {
    if (!product || !Array.isArray(product.variants) || !Array.isArray(optionIds)
        || !optionIds.every((id) => safeId(id))) throw readError('OPTION_INVALID');
    const wanted = [.../** @type {string[]} */ (optionIds)];
    const matches = product.variants.filter((variant) => variant.option_ids.length === wanted.length
        && variant.option_ids.every((id, index) => id === wanted[index]));
    if (matches.length !== 1) throw readError('OPTION_INVALID');
    return matches[0];
}

/** Hashes only stable cart/product fields using a canonical JSON representation. */
export function fingerprintCartState(value) {
    const canonical = canonicalValue(value);
    return `fp_${createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32)}`;
}

function canonicalValue(value) {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
    }
    return value;
}

/**
 * Resolves an absolute target quantity for one exact product/variant.
 * @param {any} product
 * @param {any} cart
 * @param {{ option_ids: string[], quantity: number, expected_unit_price: number, dry_run?: boolean }} input
 * @param {{ device_id: string, epoch: number, mcp_session_id: string, session_id: string, worker_id: string, account_key: string, now?: number }} binding
 */
export function prepareCart(product, cart, input, binding) {
    if (!product?.supported || !cart?.supported || product.layout_version !== CART_FIXTURE_LAYOUT || cart.layout_version !== CART_FIXTURE_LAYOUT) {
        throw readError('SITE_UNSUPPORTED');
    }
    if (!input || !Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 99) throw readError('QUANTITY_INVALID');
    if (!Number.isSafeInteger(input.expected_unit_price) || input.expected_unit_price < 0) throw readError('INVALID_ARGUMENTS');
    const variant = resolveVariant(product, input.option_ids);
    if (variant.stock_limit < 1) throw readError('OUT_OF_STOCK');
    if (input.quantity > variant.stock_limit) throw readError('OUT_OF_STOCK');
    if (variant.unit_price_krw !== input.expected_unit_price) throw readError('PRICE_CHANGED');
    const matching = cart.lines.filter((line) => line.product_id === product.product_id && line.variant_id === variant.variant_id);
    if (matching.length > 1) throw readError('STATE_UNSAFE');
    const currentQuantity = matching[0]?.quantity ?? 0;
    const unchangedLines = cart.lines.filter((line) => line !== matching[0]);
    const now = Number.isSafeInteger(binding?.now) ? binding.now : Date.now();
    const intent = {
        intent_id: `ci_${randomBytes(12).toString('hex')}`,
        device_id: binding.device_id,
        epoch: binding.epoch,
        mcp_session_id: binding.mcp_session_id,
        session_id: binding.session_id,
        worker_id: binding.worker_id,
        account_key: binding.account_key,
        product_id: product.product_id,
        product_fingerprint: product.fingerprint,
        variant_id: variant.variant_id,
        option_ids: [...variant.option_ids],
        current_quantity: currentQuantity,
        target_quantity: input.quantity,
        unit_price_krw: variant.unit_price_krw,
        layout_version: product.layout_version,
        cart_fingerprint: cart.fingerprint,
        unrelated_lines_fingerprint: fingerprintCartState(stableCartLines(unchangedLines)),
        dry_run: input.dry_run !== false,
        created_at: now,
        expires_at: now + CART_INTENT_TTL_MS,
    };
    return {
        intent,
        resolved_variant: { variant_id: variant.variant_id, option_ids: [...variant.option_ids] },
        current_quantity: currentQuantity,
        target_quantity: input.quantity,
        unit_price_krw: variant.unit_price_krw,
        predicted_change: currentQuantity === 0 ? 'add' : (currentQuantity === input.quantity ? 'unchanged' : 'update'),
    };
}

/**
 * Confirms positive cart-only response evidence and exact readback.
 * @param {any} beforeCart @param {any} afterCart @param {any} response @param {any} intent
 */
export function verifyCartResult(beforeCart, afterCart, response, intent) {
    if (response?.order_created === true || response?.kind === 'order' || response?.kind === 'checkout') {
        throw readError('ORDER_CREATION_DETECTED');
    }
    if (response?.cart_only !== true || response?.kind !== 'cart' || response?.order_created !== false || !afterCart?.supported) {
        throw readError('CART_CONFIRMATION_FAILED');
    }
    const target = afterCart.lines.filter((line) => line.product_id === intent.product_id && line.variant_id === intent.variant_id);
    const unrelated = afterCart.lines.filter((line) => line.product_id !== intent.product_id || line.variant_id !== intent.variant_id);
    if (target.length !== 1 || target[0].quantity !== intent.target_quantity || target[0].unit_price_krw !== intent.unit_price_krw) {
        throw readError('CART_CONFIRMATION_FAILED');
    }
    if (fingerprintCartState(stableCartLines(unrelated)) !== intent.unrelated_lines_fingerprint) throw readError('CART_CONFIRMATION_FAILED');
    if (fingerprintCartState(stableCartLines(beforeCart.lines.filter((line) => line.product_id !== intent.product_id || line.variant_id !== intent.variant_id)))
        !== intent.unrelated_lines_fingerprint) throw readError('CART_CONFIRMATION_FAILED');
    return {
        verified: true,
        quantity: target[0].quantity,
        unit_price_krw: target[0].unit_price_krw,
        no_order_created: response.order_created === false,
        verification_basis: 'cart_only_response_and_matching_readback',
    };
}

/**
 * Dry-run only inspects. Live writes require a private verified port capability,
 * which the production runtime does not create in this PR.
 * @param {any} port @param {any} intent @param {{ dry_run?: boolean, now?: number, persistDispatching?: () => Promise<void> }} options
 */
export async function setCartQuantity(port, intent, options = {}) {
    const dryRun = options.dry_run !== false;
    if (intent.expires_at <= (options.now ?? Date.now())) throw readError('INTENT_EXPIRED');
    if (!dryRun && intent.dry_run) throw readError('ACTION_DENIED');
    if (dryRun) {
        if (typeof port?.inspect !== 'function') throw readError('SITE_UNSUPPORTED');
        const current = await port.inspect();
        if (current?.reason === 'LOGIN_REQUIRED' || current?.login) throw readError('LOGIN_REQUIRED');
        if (current?.reason === 'HUMAN_REQUIRED' || current?.human) throw readError('HUMAN_REQUIRED');
        if (!current?.product?.supported || !current?.cart?.supported) throw readError('SITE_UNSUPPORTED');
        if (current?.product && current.product.fingerprint !== intent.product_fingerprint) {
            const currentVariant = resolveVariant(current.product, intent.option_ids);
            if (currentVariant.unit_price_krw !== intent.unit_price_krw) throw readError('PRICE_CHANGED');
            throw readError('STATE_CHANGED');
        }
        if (current?.cart && current.cart.fingerprint !== intent.cart_fingerprint) throw readError('STATE_CHANGED');
        return {
            status: 'DRY_RUN',
            site_changed: false,
            order_created: false,
            line: {
                product_id: intent.product_id,
                variant_id: intent.variant_id,
                quantity: intent.target_quantity,
                unit_price_krw: intent.unit_price_krw,
            },
            verification_basis: 'no_mutation_dispatched',
        };
    }
    if (!port || !VERIFIED_CART_PORTS.has(port)) throw readError('SITE_UNSUPPORTED');
    const before = await port.inspect();
    if (before?.reason === 'LOGIN_REQUIRED') throw readError('LOGIN_REQUIRED');
    if (before?.reason === 'HUMAN_REQUIRED') throw readError('HUMAN_REQUIRED');
    if (!before?.product?.supported || !before?.cart?.supported) throw readError('SITE_UNSUPPORTED');
    const variant = resolveVariant(before.product, intent.option_ids);
    if (variant.unit_price_krw !== intent.unit_price_krw) throw readError('PRICE_CHANGED');
    if (variant.variant_id !== intent.variant_id) throw readError('STATE_CHANGED');
    if (before.product.fingerprint !== intent.product_fingerprint || before.cart.fingerprint !== intent.cart_fingerprint) throw readError('STATE_CHANGED');
    await options.persistDispatching?.();
    let response;
    try {
        response = await port.mutate({ product_id: intent.product_id, variant_id: intent.variant_id, quantity: intent.target_quantity });
    } catch {
        throw readError('OUTCOME_UNKNOWN');
    }
    const after = await port.inspect();
    const verified = verifyCartResult(before.cart, after.cart, response, intent);
    return { status: 'SUCCEEDED', site_changed: true, order_created: false, line: {
        product_id: intent.product_id,
        variant_id: intent.variant_id,
        quantity: verified.quantity,
        unit_price_krw: verified.unit_price_krw,
    }, verification_basis: verified.verification_basis };
}

/**
 * Only an exact, one-use worker-created permit can authorize a cart mutation.
 * Without evidence-backed adapter values every request, including POST, fails closed.
 * @param {{ url: string, method: string, payload?: unknown, permit?: { url: string, method: string, payload: unknown, consume: () => boolean } | null }} request
 */
export function classifyCartRequest(request) {
    let url;
    try { url = new URL(request.url); } catch { return 'deny'; }
    if (url.protocol !== 'https:' || CHECKOUT_PATH.test(url.pathname)) return 'deny';
    const method = String(request.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return 'read';
    const permit = request.permit;
    if (!permit || permit.url !== url.toString() || permit.method !== method) return 'deny';
    if (JSON.stringify(canonicalValue(request.payload)) !== JSON.stringify(canonicalValue(permit.payload))) return 'deny';
    const body = /** @type {any} */ (request.payload);
    if (!body || Object.keys(body).sort().join(',') !== 'product_id,quantity,variant_id'
        || !safeId(body.product_id) || !safeId(body.variant_id)
        || !Number.isInteger(body.quantity) || body.quantity < 1 || body.quantity > 99) return 'deny';
    return permit.consume() ? 'allow-once' : 'deny';
}
