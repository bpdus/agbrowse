// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {AgentOp, PageHandlerFactory, PageHandlerRemote} from './mybrowse.mojom-webui.js';
import type {BookmarkInfo, TabActionResult} from './mybrowse.mojom-webui.js';

export type {BookmarkInfo};

export interface SessionSummary {
  id: string;
  host: string;
  title: string;
  engine: string;
  mode: string;
  status: string;
  revision: number;
  created_at?: string;
  updated_at?: string;
}

export interface Session {
  id: string;
  host: string;
  prompt: string;
  task?: string;
  engine: string;
  mode: string;
  status: string;
  revision: number;
  created_at?: string;
  updated_at?: string;
}

export interface SessionEvent {
  seq: number;
  type: string;
  data?: Record<string, unknown>;
}

export interface HealthData {
  host: string;
  capabilities?: {browser?: boolean};
}

export interface ListData {
  sessions: SessionSummary[];
  next_before_rowid: number|null;
  has_more: boolean;
}

export interface EventsData {
  events: SessionEvent[];
  next_seq: number;
  has_more: boolean;
}

export interface SessionData {
  session: Session;
}

export interface IpcError {
  status: number;
  code: string;
  message: string;
}

export type IpcResponse<T> =
    {version: number, id?: string, ok: true, data: T}|
    {version: number, id?: string, ok: false, error: IpcError};

// |outcomeUnknown| is true when a mutating request may have been applied.
export class BridgeError extends Error {
  constructor(
      readonly code: string, message: string,
      readonly outcomeUnknown = false) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = 40000;
const READ_RETRIES = 2;
const READ_RETRY_DELAY_MS = 400;
const RETRYABLE = new Set(['agent_unavailable', 'agent_timeout', 'timeout']);

const ERROR_TEXT: Record<string, string> = {
  agent_unavailable: '로컬 에이전트에 연결할 수 없습니다.',
  agent_timeout: '로컬 에이전트 응답이 지연되고 있습니다.',
  timeout: '응답 시간이 초과되었습니다.',
  proxy_error: '브라우저 프로세스 연결 오류',
};

export function errorText(e: unknown): string {
  if (e instanceof BridgeError) {
    const base = ERROR_TEXT[e.code] || e.message || e.code;
    return e.outcomeUnknown ?
        `${base} 요청이 처리되었는지 확인할 수 없습니다. 목록을 확인한 뒤 다시 시도하세요.` :
        base;
  }
  return ERROR_TEXT['proxy_error']!;
}

let handlerPromise: Promise<PageHandlerRemote>|null = null;

function getHandler(): Promise<PageHandlerRemote> {
  if (!handlerPromise) {
    handlerPromise = new Promise((resolve, reject) => {
      try {
        const handler = new PageHandlerRemote();
        PageHandlerFactory.getRemote().createPageHandler(
            handler.$.bindNewPipeAndPassReceiver());
        resolve(handler);
      } catch (e) {
        reject(new BridgeError('proxy_error', ERROR_TEXT['proxy_error']!));
      }
    });
    handlerPromise.catch(() => {
      handlerPromise = null;
    });
  }
  return handlerPromise;
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
        () => reject(new BridgeError('timeout', ERROR_TEXT['timeout']!)),
        REQUEST_TIMEOUT_MS);
    promise.then(
        v => {
          clearTimeout(timer);
          resolve(v);
        },
        () => {
          clearTimeout(timer);
          reject(new BridgeError('proxy_error', ERROR_TEXT['proxy_error']!));
        });
  });
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function requestOnce<T>(
    op: AgentOp, payload: object, mutating: boolean): Promise<T> {
  let json: string;
  try {
    const handler = await getHandler();
    const {reply} =
        await withTimeout(handler.request(op, JSON.stringify(payload)));
    if (reply.errorName) {
      // A mutating request that was sent may have been applied.
      throw new BridgeError(
          reply.errorName, ERROR_TEXT[reply.errorName] || reply.errorName,
          mutating && reply.errorName !== 'agent_unavailable');
    }
    json = reply.responseJson;
  } catch (e) {
    // A mutating request that hit a timeout or proxy error may have been
    // applied, so keep the outcome-unknown marker and never resend it.
    if (e instanceof BridgeError) {
      return Promise.reject(
          mutating && !e.outcomeUnknown &&
                  (e.code === 'timeout' || e.code === 'proxy_error') ?
              new BridgeError(e.code, e.message, true) :
              e);
    }
    throw new BridgeError(
        'proxy_error', ERROR_TEXT['proxy_error']!, mutating);
  }
  let parsed: IpcResponse<T>;
  try {
    parsed = JSON.parse(json) as IpcResponse<T>;
  } catch (e) {
    throw new BridgeError(
        'bad_response', '응답 형식이 올바르지 않습니다.', mutating);
  }
  if (!parsed.ok) {
    throw new BridgeError(parsed.error.code, parsed.error.message);
  }
  return parsed.data;
}

// Read requests retry briefly on transport errors; mutating requests never do.
async function read<T>(op: AgentOp, payload: object): Promise<T> {
  for (let attempt = 0;; attempt++) {
    try {
      return await requestOnce<T>(op, payload, false);
    } catch (e) {
      if (attempt >= READ_RETRIES || !(e instanceof BridgeError) ||
          !RETRYABLE.has(e.code)) {
        throw e;
      }
      await sleep(READ_RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

export const health = () => read<HealthData>(AgentOp.kHealth, {});

export function listSessions(beforeRowid?: number, limit = 100) {
  const payload: Record<string, number> = {limit};
  if (beforeRowid !== undefined) {
    payload['before_rowid'] = beforeRowid;
  }
  return read<ListData>(AgentOp.kList, payload);
}

export const getSession = (id: string) =>
    read<SessionData>(AgentOp.kGet, {id});

export const readEvents = (id: string, afterSeq: number, limit = 100) =>
    read<EventsData>(AgentOp.kEvents, {id, after_seq: afterSeq, limit});

export interface CreateBody {
  prompt: string;
  host: string;
  engine: 'codex'|'claude';
  mode: 'chat'|'browser';
  client_id: string;
  request_id: string;
}

export const createSession = (body: CreateBody) =>
    requestOnce<SessionData>(AgentOp.kCreate, body, true);

export interface CommandBody {
  id: string;
  action: 'resume'|'stop'|'steer'|'queue';
  text: string;
  expected_revision: number;
  request_id: string;
}

export const sendCommand = (body: CommandBody) =>
    requestOnce<SessionData>(AgentOp.kCommand, body, true);

async function tabCall(
    call: (h: PageHandlerRemote) => Promise<{result: TabActionResult}>):
    Promise<number> {
  const handler = await getHandler();
  const {result} = await withTimeout(call(handler));
  if (result.errorName) {
    throw new BridgeError(result.errorName, result.errorName);
  }
  return result.tabId;
}

export const openTab = (url: string) => tabCall(h => h.openTab(url));
export const openSession = (id: string) => tabCall(h => h.openSession(id));
export const openHome = () => tabCall(h => h.openHome());

export async function getBookmarks():
    Promise<{loaded: boolean, bookmarks: BookmarkInfo[]}> {
  const handler = await getHandler();
  const {result} = await withTimeout(handler.getBookmarks());
  if (result.errorName) {
    throw new BridgeError(result.errorName, result.errorName);
  }
  return {loaded: result.loaded, bookmarks: result.bookmarks};
}
