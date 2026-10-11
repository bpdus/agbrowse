// @ts-check
/** In-memory fixture port. It never opens a socket or makes an HTTP request. */

export function createFakeCartPort({ product, cart, response = null } = {}) {
    let currentProduct = structuredClone(product);
    let currentCart = structuredClone(cart);
    const actions = [];
    return {
        actions,
        get product() { return structuredClone(currentProduct); },
        get cart() { return structuredClone(currentCart); },
        async inspect() {
            return { product: structuredClone(currentProduct), cart: structuredClone(currentCart) };
        },
        simulateMutation({ product_id, variant_id, quantity }) {
            actions.push({ kind: 'fixture-simulation', product_id, variant_id, quantity });
            currentCart.lines = currentCart.lines.filter((line) => line.product_id !== product_id || line.variant_id !== variant_id);
            currentCart.lines.push({
                line_id: 'line-simulated',
                product_id,
                variant_id,
                quantity,
                unit_price_krw: currentProduct.variants.find((item) => item.variant_id === variant_id).unit_price_krw,
            });
            currentCart.fingerprint = undefined;
            return structuredClone(response ?? { kind: 'cart', cart_only: true, order_created: false });
        },
        replaceProduct(next) { currentProduct = structuredClone(next); },
        replaceCart(next) { currentCart = structuredClone(next); },
    };
}
