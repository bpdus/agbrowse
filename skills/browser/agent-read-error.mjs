// @ts-check
/**
 * Fixed public errors for the read MCP surface.
 * Callers must not attach exception text, URLs, queries, or browser output.
 */

export const READ_ERROR_MESSAGES = Object.freeze({
    ACTION_DENIED: 'The action is not permitted.',
    ALREADY_RUNNING: 'Agent runtime is already running.',
    AUTH_EXPIRED: 'Authentication has expired.',
    AUTH_INVALID: 'Authentication was rejected.',
    BROWSER_DISCONNECTED: 'Browser disconnected.',
    DEVICE_REVOKED: 'Device has been revoked.',
    DOMAIN_DENIED: 'The destination is not permitted.',
    HUMAN_REQUIRED: 'A person must continue.',
    LOGIN_REQUIRED: 'Log in manually in the browser to continue.',
    OPTION_INVALID: 'The selected product option is not available.',
    QUANTITY_INVALID: 'The requested quantity is invalid.',
    OUT_OF_STOCK: 'The requested quantity is not available in stock.',
    PRICE_CHANGED: 'The product price changed; prepare the cart again.',
    INTENT_EXPIRED: 'The prepared cart intent has expired.',
    IDEMPOTENCY_CONFLICT: 'The idempotency key was used for different cart content.',
    CART_CONFIRMATION_FAILED: 'The cart change could not be confirmed.',
    ORDER_CREATION_DETECTED: 'An order action was detected and blocked.',
    OUTCOME_UNKNOWN: 'The cart operation outcome is unknown; reconcile it before continuing.',
    ACCOUNT_BLOCKED: 'Cart writes are blocked pending operation reconciliation.',
    INTERNAL: 'The request failed.',
    INVALID_ARGUMENTS: 'Arguments were rejected.',
    NOT_RUNNING: 'Agent runtime is not running.',
    LOGIN_MODE_REQUIRED: 'Login mode is not active.',
    PASSWORD_REFUSED: 'Password fields cannot be filled by this tool.',
    PROFILE_RELEASE_TIMEOUT: 'Chrome has not released the dedicated profile.',
    SCOPE_DENIED: 'Requested scope was denied.',
    SESSION_CLOSED: 'Session is closed.',
    SESSION_NOT_FOUND: 'Session was not found.',
    SITE_UNSUPPORTED: 'This page is not a supported listing.',
    STALE_REF: 'The ref is not in the current snapshot.',
    STATE_CHANGED: 'The document changed.',
    STATE_LOCK_STALE: 'The writer lock is stale; remove the exact lock file path shown in the error message manually.',
    STATE_UNSAFE: 'Stored state is not safe to use.',
    SHUTDOWN_FAILED: 'Browser shutdown failed.',
    STARTUP_FAILED: 'Browser launch failed.',
    VERSION_UNSUPPORTED: 'Protocol version is not supported.',
});

export class AgentReadError extends Error {
    /**
     * @param {string} code
     * @param {string} message
     */
    constructor(code, message) {
        super(message);
        this.name = 'AgentReadError';
        this.code = code;
    }
}

/**
 * @param {string} code
 * @returns {AgentReadError}
 */
export function readError(code) {
    const known = Object.hasOwn(READ_ERROR_MESSAGES, code);
    const safe = known ? code : 'INTERNAL';
    return new AgentReadError(safe, READ_ERROR_MESSAGES[/** @type {keyof typeof READ_ERROR_MESSAGES} */ (safe)]);
}
