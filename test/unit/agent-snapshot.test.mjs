import { describe, expect, it } from 'vitest';
import { createSnapshotStore } from '../../skills/browser/agent-snapshot.mjs';

const sessionId = `ses_${'ab'.repeat(8)}`;
const otherSession = `ses_${'cd'.repeat(8)}`;

function commit(store, overrides = {}) {
    return store.commit({
        deviceId: 'dev_a',
        epoch: 1,
        sessionId,
        tabId: 'tab-1',
        frameId: 'frame_main',
        documentEpoch: 1,
        requestId: 'req_snap',
        baseSnapshotId: `snap_${'ef'.repeat(8)}`,
        page: {
            origin: 'https://search.naver.com',
            url: 'https://search.naver.com/search.naver',
            title: 'Listing canary-token-value',
        },
        nodes: [
            {
                rank: 1,
                title: 'Alpha canary-password-value',
                snippet: 'Snippet canary-otp-value',
                url: 'https://news.example/a',
            },
            { rank: 2, title: 'Beta', snippet: 'Second', url: 'https://news.example/b' },
        ],
        maxNodes: 120,
        ...overrides,
    });
}

describe('agent snapshots', () => {
    it('returns a full snapshot and only the listing read action', () => {
        const store = createSnapshotStore();
        const snap = commit(store);
        expect(snap.kind).toBe('full');
        expect(snap.base_snapshot_id).toMatch(/^snap_[a-f0-9]{16}$/);
        expect(snap.content_trust).toBe('untrusted');
        expect(snap.truncated).toBe(false);
        expect(snap.redactions).toEqual([
            'password_fields',
            'otp_fields',
            'account_identifiers',
            'input_values',
            'cookies',
            'headers',
            'storage',
            'raw_html',
            'screenshots',
        ]);
        expect(snap.nodes).toHaveLength(2);
        expect(snap.nodes[0].allowed_actions).toEqual(['naver.search.result.read']);
        expect(JSON.stringify(snap)).not.toMatch(/canary-password-value|canary-token-value|canary-otp-value/);
        const resolved = store.resolve({
            ref: snap.nodes[0].ref,
            deviceId: 'dev_a',
            epoch: 1,
            sessionId,
            action: 'naver.search.result.read',
        });
        expect(resolved.ref).toBe(snap.nodes[0].ref);
        expect(resolved.url).toBe('https://news.example/a');
    });

    it('rejects stale, truncated, cross-owner, and substituted refs', () => {
        const store = createSnapshotStore();
        const first = commit(store);
        const ref = first.nodes[0].ref;
        const second = commit(store, { documentEpoch: 2, requestId: 'req_next' });
        expect(second.kind).toBe('full');
        expect(() => store.resolve({
            ref,
            deviceId: 'dev_a',
            epoch: 1,
            sessionId,
            action: 'naver.search.result.read',
        })).toThrow(expect.objectContaining({ code: 'STALE_REF', message: 'The ref is not in the current snapshot.' }));

        const current = commit(store, { documentEpoch: 3 });
        expect(() => store.resolve({
            ref: current.nodes[0].ref,
            deviceId: 'dev_b',
            epoch: 1,
            sessionId,
            action: 'naver.search.result.read',
        })).toThrow(expect.objectContaining({ code: 'ACTION_DENIED' }));
        expect(() => store.resolve({
            ref: current.nodes[0].ref,
            deviceId: 'dev_a',
            epoch: 1,
            sessionId: otherSession,
            action: 'naver.search.result.read',
        })).toThrow(expect.objectContaining({ code: 'ACTION_DENIED' }));
        expect(() => store.resolve({
            ref: current.nodes[0].ref,
            deviceId: 'dev_a',
            epoch: 1,
            sessionId,
            tabId: 'tab-other',
            action: 'naver.search.result.read',
        })).toThrow(expect.objectContaining({ code: 'ACTION_DENIED' }));
        expect(() => store.resolve({
            ref: current.nodes[0].ref,
            deviceId: 'dev_a',
            epoch: 1,
            sessionId,
            action: 'cart.add',
        })).toThrow(expect.objectContaining({ code: 'ACTION_DENIED' }));

        const changed = store.resolve({
            ref: current.nodes[1].ref,
            deviceId: 'dev_a',
            epoch: 1,
            sessionId,
            action: 'naver.search.result.read',
            currentNodes: [
                { rank: 1, title: 'SubstitutedTitle', snippet: 'other', url: 'https://news.example/z' },
                { rank: 2, title: 'Beta', snippet: 'Second', url: 'https://news.example/b' },
            ],
        });
        expect(changed.title).toBe('Beta');
        expect(() => store.resolve({
            ref: current.nodes[0].ref,
            deviceId: 'dev_a',
            epoch: 1,
            sessionId,
            action: 'naver.search.result.read',
            currentNodes: [
                { rank: 1, title: 'SubstitutedTitle', snippet: 'other', url: 'https://news.example/z' },
            ],
            currentEpoch: 3,
        })).toThrow(expect.objectContaining({ code: 'STATE_CHANGED', message: 'The document changed.' }));

        expect(() => store.resolve({
            ref: current.nodes[0].ref,
            deviceId: 'dev_a',
            epoch: 1,
            sessionId,
            action: 'naver.search.result.read',
            currentEpoch: 9,
        })).toThrow(expect.objectContaining({ code: 'STATE_CHANGED' }));

        store.noteEpoch(sessionId, 4);
        expect(() => store.resolve({
            ref: current.nodes[1].ref,
            deviceId: 'dev_a',
            epoch: 1,
            sessionId,
            action: 'naver.search.result.read',
        })).toThrow(expect.objectContaining({ code: 'STALE_REF' }));

        const truncated = commit(store, { maxNodes: 1, documentEpoch: 5 });
        expect(truncated.truncated).toBe(true);
        expect(truncated.nodes).toHaveLength(1);
        expect(() => store.resolve({
            ref: truncated.nodes[0].ref,
            deviceId: 'dev_a',
            epoch: 1,
            sessionId,
            action: 'naver.search.result.read',
        })).toThrow(expect.objectContaining({ code: 'STALE_REF' }));
        expect(() => commit(store, { frameId: 'frame_other' })).toThrow(expect.objectContaining({ code: 'ACTION_DENIED' }));
    });

    it('rejects a replaced element that publishes the same fields', () => {
        const store = createSnapshotStore();
        const snap = commit(store, {
            nodes: [
                { rank: 1, title: 'Alpha', snippet: 'Snippet', url: 'https://news.example/a', node_id: 'n_1' },
                { rank: 2, title: 'Beta', snippet: 'Second', url: 'https://news.example/b', node_id: 'n_2' },
            ],
        });
        expect(snap.nodes[0]).not.toHaveProperty('node_id');
        expect(JSON.stringify(snap.nodes)).not.toContain('node_id');
        const same = store.resolve({
            ref: snap.nodes[0].ref,
            deviceId: 'dev_a',
            epoch: 1,
            sessionId,
            action: 'naver.search.result.read',
            currentNodes: [
                { rank: 1, title: 'Alpha', snippet: 'Snippet', url: 'https://news.example/a', node_id: 'n_1' },
            ],
        });
        expect(same).toMatchObject({ title: 'Alpha', url: 'https://news.example/a' });
        expect(same).not.toHaveProperty('node_id');
        expect(() => store.resolve({
            ref: snap.nodes[0].ref,
            deviceId: 'dev_a',
            epoch: 1,
            sessionId,
            action: 'naver.search.result.read',
            currentNodes: [
                { rank: 1, title: 'Alpha', snippet: 'Snippet', url: 'https://news.example/a', node_id: 'n_9' },
            ],
        })).toThrow(expect.objectContaining({ code: 'STATE_CHANGED', message: 'The document changed.' }));
    });
});
