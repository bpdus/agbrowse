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
    INTERNAL: 'The request failed.',
    INVALID_ARGUMENTS: 'Arguments were rejected.',
    NOT_RUNNING: 'Agent runtime is not running.',
    SCOPE_DENIED: 'Requested scope was denied.',
    SESSION_CLOSED: 'Session is closed.',
    SESSION_NOT_FOUND: 'Session was not found.',
    SITE_UNSUPPORTED: 'This page is not a supported listing.',
    STALE_REF: 'The ref is not in the current snapshot.',
    STATE_CHANGED: 'The document changed.',
    STATE_UNSAFE: 'Stored state is not safe to use.',
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
