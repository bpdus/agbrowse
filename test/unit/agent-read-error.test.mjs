import { describe, expect, it } from 'vitest';
import { AgentReadError, READ_ERROR_MESSAGES, readError } from '../../skills/browser/agent-read-error.mjs';

describe('agent read errors', () => {
    it('returns a fixed message and hides unknown codes', () => {
        const stale = readError('STALE_REF');
        expect(stale).toBeInstanceOf(AgentReadError);
        expect(stale.code).toBe('STALE_REF');
        expect(stale.message).toBe(READ_ERROR_MESSAGES.STALE_REF);
        expect(stale.message).toBe('The ref is not in the current snapshot.');

        const hidden = readError('NO_SUCH_CODE');
        expect(hidden.code).toBe('INTERNAL');
        expect(hidden.message).toBe('The request failed.');
        expect(`${hidden.message}\n${hidden.stack}`).not.toContain('NO_SUCH_CODE');
    });
});
