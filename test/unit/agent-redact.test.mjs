import { describe, expect, it } from 'vitest';
import { isPrivateHostname, redactText, redactValue, sanitizeDestinationUrl } from '../../skills/browser/agent-redact.mjs';

describe('agent redaction', () => {
    it('redacts secret-shaped text and leaves ordinary words', () => {
        const input = [
            'Bearer abcdefghijk',
            'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0In0.signature',
            'password=hunter2',
            'canary-password-value',
            'canary-token-value',
            'canary-otp-value',
            'canary-secret-value',
            'token_type',
        ].join(' ');
        const cleaned = redactText(input);
        expect(cleaned).not.toMatch(/abcdefghijk|eyJhbGci|hunter2|canary-password-value|canary-token-value|canary-otp-value|canary-secret-value/);
        expect(cleaned).toContain('[redacted]');
        expect(cleaned).toContain('token_type');
    });

    it('walks structured values before they can be printed', () => {
        const value = redactValue({
            title: 'Alpha canary-password-value',
            nested: ['otp=123456', { url: 'https://news.example/a?token=canary-token-value' }],
        });
        expect(JSON.stringify(value)).not.toMatch(/canary-password-value|canary-token-value|123456/);
    });

    it('redacts secret canaries nested in cart operation fields', () => {
        const result = redactValue({
            operation: { status: 'OUTCOME_UNKNOWN', request: 'request_id=caller-safe' },
            diagnostics: ['password=canary-password-value', 'cookie=canary-cookie-value', 'token=canary-token-value'],
        });
        expect(JSON.stringify(result)).not.toMatch(/canary-password-value|canary-cookie-value|canary-token-value/);
        expect(result.operation.status).toBe('OUTCOME_UNKNOWN');
    });

    it('keeps only public https destinations and drops secret query fields', () => {
        expect(sanitizeDestinationUrl('https://news.example/a?token=canary-token-value&ok=1#secret', {})).toBe('https://news.example/a?ok=1');
        expect(sanitizeDestinationUrl('https://user:pass@news.example/a', {})).toBeNull();
        expect(sanitizeDestinationUrl('javascript:alert(1)', {})).toBeNull();
        expect(sanitizeDestinationUrl('http://news.example/a', {})).toBeNull();
        expect(sanitizeDestinationUrl('https://169.254.169.254/latest', {})).toBeNull();
        expect(sanitizeDestinationUrl('https://news.example/a?q=hello', {})).toBe('https://news.example/a?q=hello');
        expect(sanitizeDestinationUrl('https://news.example/a?q=world', {})).toBe('https://news.example/a?q=world');
        const harness = { harnessOrigin: 'http://127.0.0.1:9' };
        expect(sanitizeDestinationUrl('http://127.0.0.1:9/item', harness)).toBe('http://127.0.0.1:9/item');
    });

    it('treats loopback and link-local names as private', () => {
        expect(isPrivateHostname('127.0.0.1')).toBe(true);
        expect(isPrivateHostname('169.254.169.254')).toBe(true);
        expect(isPrivateHostname('10.1.2.3')).toBe(true);
        expect(isPrivateHostname('news.example')).toBe(false);
    });
});
