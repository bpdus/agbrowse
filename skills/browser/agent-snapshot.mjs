// @ts-check
/**
 * Full snapshots and opaque ref bindings for the read MVP.
 * Diffs are deferred: a supplied base still returns a full snapshot.
 * Browser objects are not stored here.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readError } from './agent-read-error.mjs';
import { redactText } from './agent-redact.mjs';

export const DOMAIN_PROTOCOL_VERSION = '0.1.0';
export const READ_ACTION = 'naver.search.result.read';
export const FRAME_MAIN = 'frame_main';
const REDACTIONS = Object.freeze([
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

/**
 * @param {string} prefix
 * @param {number} bytes
 */
function newId(prefix, bytes) {
    return `${prefix}${randomBytes(bytes).toString('hex')}`;
}

/**
 * @param {{ rank: number, title: string, snippet: string, url: string }} node
 */
function identityOf(node) {
    return createHash('sha256').update(JSON.stringify({
        rank: node.rank,
        title: node.title,
        snippet: node.snippet,
        url: node.url,
    })).digest('hex');
}

/**
 * @param {unknown} value
 * @returns {{ rank: number, title: string, snippet: string, url: string }}
 */
function publicNode(value) {
    const node = /** @type {{ rank?: unknown, title?: unknown, snippet?: unknown, url?: unknown }} */ (value);
    if (!Number.isInteger(node.rank) || /** @type {number} */ (node.rank) < 1) throw readError('INVALID_ARGUMENTS');
    if (typeof node.url !== 'string' || node.url.length === 0) throw readError('INVALID_ARGUMENTS');
    return {
        rank: /** @type {number} */ (node.rank),
        title: redactText(node.title, 180),
        snippet: redactText(node.snippet, 240),
        url: node.url,
    };
}

export function createSnapshotStore() {
    /** @type {Map<string, { deviceId: string, epoch: number, sessionId: string, tabId: string, frameId: string, documentEpoch: number, snapshotId: string | null, truncated: boolean, refIds: string[] }>} */
    const sessions = new Map();
    /** @type {Map<string, { ref: string, deviceId: string, epoch: number, sessionId: string, tabId: string, frameId: string, documentEpoch: number, snapshotId: string, truncated: boolean, identity: string, node: { rank: number, title: string, snippet: string, url: string } }>} */
    const refs = new Map();

    /**
     * @param {string} sessionId
     */
    function dropRefs(sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return;
        for (const ref of session.refIds) refs.delete(ref);
        session.refIds = [];
        session.snapshotId = null;
        session.truncated = false;
    }

    /**
     * @param {string} sessionId
     */
    function dropSession(sessionId) {
        dropRefs(sessionId);
        sessions.delete(sessionId);
    }

    function dropAll() {
        refs.clear();
        sessions.clear();
    }

    /**
     * @param {{ deviceId: string, epoch: number, sessionId: string, tabId: string, frameId: string, documentEpoch: number, requestId: string, baseSnapshotId?: string | null, page: { origin: string, url: string, title: string }, nodes: Array<{ rank: number, title: string, snippet: string, url: string }>, maxNodes: number }} input
     */
    function commit(input) {
        if (input.frameId !== FRAME_MAIN) throw readError('ACTION_DENIED');
        const maxNodes = input.maxNodes;
        if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 120) throw readError('INVALID_ARGUMENTS');
        let session = sessions.get(input.sessionId);
        if (!session) {
            session = {
                deviceId: input.deviceId,
                epoch: input.epoch,
                sessionId: input.sessionId,
                tabId: input.tabId,
                frameId: input.frameId,
                documentEpoch: input.documentEpoch,
                snapshotId: null,
                truncated: false,
                refIds: [],
            };
            sessions.set(input.sessionId, session);
        }
        if (session.deviceId !== input.deviceId || session.epoch !== input.epoch) throw readError('ACTION_DENIED');
        if (session.tabId !== input.tabId || session.frameId !== input.frameId) throw readError('ACTION_DENIED');
        dropRefs(input.sessionId);
        session.documentEpoch = input.documentEpoch;
        const snapshotId = newId('snap_', 8);
        session.snapshotId = snapshotId;
        const prepared = input.nodes.map((node) => publicNode(node));
        const truncated = prepared.length > maxNodes;
        const visible = truncated ? prepared.slice(0, maxNodes) : prepared;
        /** @type {Array<Record<string, unknown>>} */
        const publicNodes = [];
        for (const node of visible) {
            const ref = newId('r_', 12);
            const record = {
                ref,
                deviceId: input.deviceId,
                epoch: input.epoch,
                sessionId: input.sessionId,
                tabId: input.tabId,
                frameId: input.frameId,
                documentEpoch: input.documentEpoch,
                snapshotId,
                truncated,
                identity: identityOf(node),
                node,
            };
            refs.set(ref, record);
            session.refIds.push(ref);
            publicNodes.push({
                ref,
                frame_id: input.frameId,
                role: 'link',
                name: node.title,
                allowed_actions: [READ_ACTION],
                rank: node.rank,
                snippet: node.snippet,
                url: node.url,
            });
        }
        session.truncated = truncated;
        return {
            protocol_version: DOMAIN_PROTOCOL_VERSION,
            request_id: input.requestId,
            session_id: input.sessionId,
            tab_id: input.tabId,
            frame_id: input.frameId,
            document_epoch: input.documentEpoch,
            snapshot_id: snapshotId,
            kind: 'full',
            base_snapshot_id: input.baseSnapshotId ?? null,
            page: {
                origin: input.page.origin,
                url: input.page.url,
                title: redactText(input.page.title, 120),
            },
            content_trust: 'untrusted',
            nodes: publicNodes,
            redactions: REDACTIONS.slice(),
            truncated,
        };
    }

    /**
     * Structural checks. A current node list, when supplied, must contain the
     * same identity. A different element is never returned in its place.
     * @param {{ ref: string, deviceId: string, epoch: number, sessionId: string, tabId?: string, frameId?: string, action: string, currentNodes?: Array<{ rank: number, title: string, snippet: string, url: string }> | null, currentEpoch?: number | null }} input
     */
    function resolve(input) {
        const record = refs.get(input.ref);
        if (!record) throw readError('STALE_REF');
        if (record.deviceId !== input.deviceId || record.epoch !== input.epoch) throw readError('ACTION_DENIED');
        if (record.sessionId !== input.sessionId) throw readError('ACTION_DENIED');
        const session = sessions.get(input.sessionId);
        if (!session || session.snapshotId !== record.snapshotId) throw readError('STALE_REF');
        if (input.tabId !== undefined && input.tabId !== record.tabId) throw readError('ACTION_DENIED');
        if (input.frameId !== undefined && input.frameId !== record.frameId) throw readError('ACTION_DENIED');
        if (input.action !== READ_ACTION || record.node == null) throw readError('ACTION_DENIED');
        if (record.truncated || session.truncated) throw readError('STALE_REF');
        if (session.documentEpoch !== record.documentEpoch) throw readError('STATE_CHANGED');
        if (input.currentEpoch != null && input.currentEpoch !== record.documentEpoch) throw readError('STATE_CHANGED');
        if (input.currentNodes) {
            const current = input.currentNodes.map((node) => publicNode(node));
            const match = current.find((node) => identityOf(node) === record.identity);
            if (!match) throw readError('STATE_CHANGED');
            return { ...match, ref: record.ref, session_id: record.sessionId };
        }
        return { ...record.node, ref: record.ref, session_id: record.sessionId };
    }

    /**
     * @param {string} sessionId
     * @param {number} documentEpoch
     */
    function noteEpoch(sessionId, documentEpoch) {
        const session = sessions.get(sessionId);
        if (!session) return;
        if (session.documentEpoch === documentEpoch) return;
        session.documentEpoch = documentEpoch;
        dropRefs(sessionId);
    }

    return { commit, resolve, dropSession, dropAll, noteEpoch };
}
