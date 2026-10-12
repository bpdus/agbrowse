import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { consumeCredentialsToken, handleCredentialsRequest, issueCredentialsToken } from '../../skills/browser/agent-credentials-admin.mjs';

describe('credential registration token', () => {
    it('is private, expires, and is single use under concurrent claims', async () => {
        const home = mkdtempSync(path.join(os.tmpdir(), 'agbrowse-token-'));
        try {
            const issued = issueCredentialsToken({ home });
            const file = path.join(home, '.agbrowse-bpdus/state/credentials-token');
            expect(statSync(file).mode & 0o777).toBe(0o600);
            const results = await Promise.all([consumeCredentialsToken(issued.token, { home }), consumeCredentialsToken(issued.token, { home })]);
            expect(results.sort()).toEqual([false, true]);
            const expired = issueCredentialsToken({ home });
            expect(await consumeCredentialsToken(expired.token, { home, now: expired.expiresAt })).toBe(false);
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
    it('consumes before save and never returns submitted values', async () => {
        const home = mkdtempSync(path.join(os.tmpdir(), 'agbrowse-token-'));
        try {
            const issued = issueCredentialsToken({ home });
            const saved = await handleCredentialsRequest({ token: issued.token, account: 'id-sentinel', password: 'pw-sentinel' }, { home, save: async () => ({ result: 'saved' }) });
            expect(saved).toEqual({ result: 'saved' });
            expect(JSON.stringify(saved)).not.toContain('sentinel');
            const fail = await handleCredentialsRequest({ token: issued.token, account: 'id-sentinel', password: 'pw-sentinel' }, { home, save: async () => ({ result: 'saved' }) });
            expect(fail).toEqual({ result: 'failed', reason: 'token_invalid' });
        } finally { rmSync(home, { recursive: true, force: true }); }
    });
});
