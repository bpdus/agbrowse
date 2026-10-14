// Copyright 2026 The MyBrowse Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {BridgeError, createSession, errorText, getBookmarks, getSession, health, listSessions, openHome, openSession, openTab, readEvents, sendCommand} from './bridge.js';
import type {HealthData, Session, SessionEvent, SessionSummary} from './bridge.js';
import {activeSessionSelectionGuard as guard} from './selection.js';

type Surface = 'home'|'sidebar';

const LABELS: Record<string, string> = {
  queued: '예약',
  running: '실행 중',
  waiting_user: '사용자 확인 필요',
  waiting_provider: '제공자 연결 대기',
  paused: '중단',
  done: '완료',
  failed: '실패',
  uncertain: '결과 확인 필요',
};
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLL_MS = 1500;
const REFRESH_MS = 3000;
const LIST_PAGE_LIMIT = 100;
const LIST_MAX_PAGES = 5;
const EVENT_PAGE_LIMIT = 100;
const EVENT_MAX_PAGES_PER_POLL = 20;
const SEARCH_URL = 'https://www.google.com/search?q=';

const params = new URLSearchParams(location.search);
const surface: Surface = params.get('surface') === 'sidebar' ? 'sidebar' : 'home';
const querySession = (() => {
  const id = params.get('session');
  return id && UUID_RE.test(id) ? id.toLowerCase() : null;
})();

function $<T extends HTMLElement>(id: string): T|null {
  return document.getElementById(id) as T | null;
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function show(id: string, visible: boolean): void {
  $(id)?.classList.toggle('hidden', !visible);
}

function note(text: string): void {
  const box = $('notice');
  if (box) {
    box.textContent = text;
    box.classList.toggle('hidden', !text);
  }
}

function fail(e: unknown): void {
  note(errorText(e));
}

const state: {
  health: HealthData|null,
  healthFailed: boolean,
  listFailed: boolean,
  refreshRunning: boolean,
  refreshTimer: number|undefined,
  sessions: SessionSummary[],
  active: Session|null,
  assistant: HTMLElement|null,
  messageClosed: boolean,
  cursor: number,
  pollTimer: number|undefined,
  mode: 'search'|'ask',
  busy: boolean,
} = {
  health: null,
  healthFailed: false,
  listFailed: false,
  refreshRunning: false,
  refreshTimer: undefined,
  sessions: [],
  active: null,
  assistant: null,
  messageClosed: false,
  cursor: 0,
  pollTimer: undefined,
  mode: 'ask',
  busy: false,
};

// ---- Shared data ----------------------------------------------------------

async function refreshHealth(): Promise<void> {
  try {
    state.health = await health();
    state.healthFailed = false;
  } catch (e) {
    // Keep the last known health; only the connection label changes.
    state.healthFailed = true;
    fail(e);
  }
  const label = state.healthFailed ? '에이전트 연결 끊김' :
      state.health               ? `${state.health.host} · 로컬` :
                                   '로컬 연결 확인';
  const host = $('side-host');
  if (host) {
    host.textContent = label;
  }
  renderCapability();
}

// Reads a finite number of summary pages; originals come from get.
async function refreshSessions(): Promise<void> {
  try {
    const all: SessionSummary[] = [];
    let before: number|undefined;
    for (let page = 0; page < LIST_MAX_PAGES; page++) {
      const data = await listSessions(before, LIST_PAGE_LIMIT);
      all.push(...data.sessions);
      if (!data.has_more || data.next_before_rowid === null) {
        break;
      }
      before = data.next_before_rowid;
    }
    state.sessions = all;
    state.listFailed = false;
    renderLists();
  } catch (e) {
    // Keep the previous list on failure.
    state.listFailed = true;
    fail(e);
  }
}

// Non-overlapping refresh: the next timeout is scheduled only after the
// previous health and list reads have settled.
async function refreshTick(): Promise<void> {
  state.refreshTimer = undefined;
  await refreshHealth();
  await refreshSessions();
  if (!state.healthFailed && !state.listFailed) {
    note('');
  }
  if (state.refreshRunning) {
    state.refreshTimer = window.setTimeout(() => void refreshTick(), REFRESH_MS);
  }
}

function startRefresh(): void {
  if (state.refreshRunning) {
    return;
  }
  state.refreshRunning = true;
  void refreshTick();
}

function stopRefresh(): void {
  state.refreshRunning = false;
  window.clearTimeout(state.refreshTimer);
  state.refreshTimer = undefined;
}

function summaryTitle(s: SessionSummary): string {
  return s.title || s.id;
}

async function openUrl(url: string): Promise<void> {
  try {
    await openTab(url);
  } catch (e) {
    fail(e);
  }
}

async function openSessionTab(id: string): Promise<void> {
  try {
    await openSession(id);
  } catch (e) {
    fail(e);
  }
}

// ---- Lists ----------------------------------------------------------------

function renderLists(): void {
  const chats = $('side-chats');
  if (chats) {
    chats.replaceChildren();
    for (const s of state.sessions) {
      const b = el('button', 'chat-entry' + (state.active?.id === s.id ? ' active' : ''));
      b.append(el('span', '', summaryTitle(s)));
      if (s.status === 'running') {
        b.append(el('span', 'small-dot'));
      }
      b.addEventListener('click', () => void openSessionTab(s.id));
      chats.append(b);
    }
    if (!state.sessions.length) {
      chats.append(el('p', 'empty', '대화가 없습니다.'));
    }
  }
  const recent = $('recent-tasks');
  const count = $('task-count');
  if (count) {
    count.textContent = `${state.sessions.length}개의 대화`;
  }
  if (recent) {
    recent.replaceChildren();
    for (const s of state.sessions.slice(0, 6)) {
      const card = el('button', 'task-card');
      card.append(
          el('span', 'meta',
             s.updated_at ? new Date(s.updated_at).toLocaleString('ko-KR') : ''),
          el('strong', '', summaryTitle(s)),
          el('span', 'card-bottom', `${s.engine} · ${LABELS[s.status] || s.status}`));
      card.addEventListener('click', () => void openSessionTab(s.id));
      recent.append(card);
    }
    if (!state.sessions.length) {
      recent.append(el('div', 'empty-card', '첫 대화를 시작하면 작업이 여기에 남습니다.'));
    }
  }
}

async function loadBookmarks(): Promise<void> {
  const box = $('side-bookmarks');
  if (!box) {
    return;
  }
  try {
    const {loaded, bookmarks} = await getBookmarks();
    box.replaceChildren();
    for (const b of bookmarks) {
      const item = el('button', 'nav-item');
      item.append(el('span', '', b.title || b.url));
      item.title = b.url;
      item.addEventListener('click', () => void openUrl(b.url));
      box.append(item);
    }
    if (!bookmarks.length) {
      box.append(el('p', 'empty', loaded ? '북마크가 없습니다.' : '북마크를 불러오는 중입니다.'));
      if (!loaded) {
        setTimeout(() => void loadBookmarks(), 2000);
      }
    }
  } catch (e) {
    fail(e);
  }
}

// ---- Home composer ----------------------------------------------------------

function capabilityBrowser(): boolean {
  return state.health?.capabilities?.['browser'] === true;
}

function renderCapability(): void {
  const text = $('capability');
  if (text) {
    text.textContent = capabilityBrowser() ?
        '' :
        '브라우저 도구가 연결되지 않았습니다. 브라우저 작업은 연결 전까지 사용자 확인 상태로 멈춥니다.';
  }
  const option = $('mode-browser-option');
  if (option) {
    option.textContent = capabilityBrowser() ? '브라우저 작업' : '브라우저 작업 · 도구 미연결';
  }
}

function setMode(mode: 'search'|'ask'): void {
  state.mode = mode;
  $('mode-search')?.setAttribute('aria-pressed', String(mode === 'search'));
  $('mode-ask')?.setAttribute('aria-pressed', String(mode === 'ask'));
  const submit = $('submit');
  if (submit) {
    submit.textContent = mode === 'search' ? 'Search' : 'Ask';
  }
  for (const id of ['engine', 'mode']) {
    const select = $<HTMLSelectElement>(id);
    if (select) {
      select.disabled = mode === 'search';
    }
  }
}

function searchUrl(query: string): string {
  try {
    const url = new URL(query);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.href;
    }
  } catch (e) {
    // Not a URL; fall through to a search.
  }
  return SEARCH_URL + encodeURIComponent(query);
}

async function submitHome(): Promise<void> {
  const input = $<HTMLTextAreaElement>('prompt');
  const text = input?.value.trim() ?? '';
  if (!input || !text || state.busy) {
    return;
  }
  if (state.mode === 'search') {
    await openUrl(searchUrl(text));
    return;
  }
  if (!state.health) {
    await refreshHealth();
    if (!state.health) {
      return;
    }
  }
  const engine = $<HTMLSelectElement>('engine')?.value;
  const mode = $<HTMLSelectElement>('mode')?.value;
  if ((engine !== 'codex' && engine !== 'claude') ||
      (mode !== 'chat' && mode !== 'browser')) {
    note('지원하지 않는 실행기입니다.');
    return;
  }
  state.busy = true;
  try {
    const {session} = await createSession({
      prompt: text,
      host: state.health.host,
      engine,
      mode,
      client_id: 'mybrowse-ui',
      request_id: crypto.randomUUID(),
    });
    input.value = '';
    await openSessionTab(session.id);
    await refreshSessions();
  } catch (e) {
    // Never resend a create whose outcome is unknown; the list shows the truth.
    fail(e);
    if (e instanceof BridgeError && e.outcomeUnknown) {
      void refreshSessions();
    }
  } finally {
    state.busy = false;
  }
}

function initHome(): void {
  show('home', !querySession);
  $('mode-search')?.addEventListener('click', () => setMode('search'));
  $('mode-ask')?.addEventListener('click', () => setMode('ask'));
  setMode('ask');
  const form = $('composer');
  form?.addEventListener('submit', e => {
    e.preventDefault();
    void submitHome();
  });
  $<HTMLTextAreaElement>('prompt')?.addEventListener('keydown', e => {
    // Enter asks (or searches in Search mode); Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void submitHome();
    }
  });
  renderCapability();
}

// ---- Sidebar ----------------------------------------------------------------

function initSidebar(): void {
  show('sidebar', true);
  $('side-home')?.addEventListener('click', () => void openHome().catch(fail));
  $('side-new-chat')?.addEventListener('click', () => void openHome().catch(fail));
  $('side-new-tab')?.addEventListener('click', () => void openUrl('https://www.google.com/'));
  void loadBookmarks();
}

// ---- Conversation -----------------------------------------------------------

function updateSession(s: Session): void {
  state.active = s;
  const title = $('session-title');
  if (title) {
    title.textContent = s.prompt || s.task || s.id;
  }
  const meta = $('session-meta');
  if (meta) {
    meta.textContent = `${s.host} / ${s.engine} / ${s.id}`;
  }
  const status = $('session-status');
  if (status) {
    status.textContent = LABELS[s.status] || s.status;
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
    const action = b.dataset['action'];
    b.disabled = action === 'steer' ? s.status !== 'running' || s.engine !== 'codex' :
                                      s.status !== 'running';
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function applyEvent(e: SessionEvent): void {
  const timeline = $('timeline');
  if (!timeline) {
    return;
  }
  const data = e.data ?? {};
  const type = e.type.replace(/^engine\./, '');
  if (type === 'turn_started') {
    state.assistant = null;
    state.messageClosed = false;
    if (e.type === 'turn_started' && text(data['prompt'])) {
      timeline.append(el('div', 'bubble user', text(data['prompt'])));
    }
  }
  if (type === 'assistant_delta') {
    if (!state.assistant || state.messageClosed) {
      state.assistant = el('div', 'bubble assistant', '');
      state.messageClosed = false;
      timeline.append(state.assistant);
    }
    state.assistant.textContent = (state.assistant.textContent ?? '') + text(data['text']);
  }
  if (type === 'assistant_message') {
    if (!data['item_id'] || !state.assistant) {
      state.assistant = el('div', 'bubble assistant', '');
      timeline.append(state.assistant);
    }
    state.assistant.textContent = text(data['text']);
    state.messageClosed = true;
  }
  if (type === 'turn_ended' && data['status'] === 'waiting_user') {
    timeline.append(el('div', 'event-note', text(data['reason']) || '사용자 확인이 필요합니다.'));
  }
  if (['waiting_user', 'engine_error', 'browser_not_integrated', 'uncertain'].includes(type)) {
    timeline.append(
        el('div', 'event-note',
           text(data['reason']) || text(data['message']) || '브라우저 연결을 기다립니다.'));
  }
}

// Reads finite event pages and preserves seq; stale responses are dropped.
async function pollEvents(id: string, ticket: ReturnType<typeof guard.begin>): Promise<void> {
  try {
    for (let page = 0; page < EVENT_MAX_PAGES_PER_POLL; page++) {
      const data = await readEvents(id, state.cursor, EVENT_PAGE_LIMIT);
      if (!guard.accepts(ticket)) {
        return;
      }
      for (const e of data.events) {
        if (e.seq > state.cursor) {
          state.cursor = e.seq;
          applyEvent(e);
        }
      }
      if (!data.has_more) {
        break;
      }
    }
    const {session} = await getSession(id);
    if (!guard.accepts(ticket)) {
      return;
    }
    updateSession(session);
  } catch (e) {
    if (guard.accepts(ticket)) {
      fail(e);
    }
  }
  if (guard.accepts(ticket)) {
    state.pollTimer = window.setTimeout(() => void pollEvents(id, ticket), POLL_MS);
  }
}

function stopPolling(): void {
  window.clearTimeout(state.pollTimer);
  state.pollTimer = undefined;
}

async function selectSession(id: string): Promise<void> {
  const ticket = guard.begin(id);
  stopPolling();
  state.active = null;
  state.assistant = null;
  state.messageClosed = false;
  state.cursor = 0;
  $('timeline')?.replaceChildren();
  show('conversation', true);
  try {
    const {session} = await getSession(id);
    if (!guard.accepts(ticket)) {
      return;
    }
    updateSession(session);
    void pollEvents(id, ticket);
  } catch (e) {
    if (guard.accepts(ticket)) {
      fail(e);
    }
  }
}

async function command(action: 'resume'|'stop'|'steer'|'queue'): Promise<void> {
  const active = state.active;
  const input = $<HTMLTextAreaElement>('followup-text');
  if (!active || !input || state.busy) {
    return;
  }
  const ticket = guard.current();
  state.busy = true;
  try {
    const {session} = await getSession(active.id);
    if (!guard.accepts(ticket) || state.active?.id !== active.id) {
      return;
    }
    // No automatic resend: a timed-out command may already have been applied.
    const response = await sendCommand({
      id: active.id,
      action,
      text: input.value.trim(),
      expected_revision: session.revision,
      request_id: crypto.randomUUID(),
    });
    if (guard.accepts(ticket)) {
      updateSession(response.session);
      input.value = '';
    }
  } catch (e) {
    fail(e);
  } finally {
    state.busy = false;
  }
}

function initConversation(id: string): void {
  $('followup')?.addEventListener('submit', e => {
    e.preventDefault();
    void command('resume');
  });
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
    b.addEventListener('click', () => {
      const action = b.dataset['action'];
      if (action === 'stop' || action === 'steer' || action === 'queue') {
        void command(action);
      }
    });
  }
  void selectSession(id);
}

// ---- Start ------------------------------------------------------------------

async function main(): Promise<void> {
  if (surface === 'sidebar') {
    initSidebar();
  } else {
    initHome();
  }
  if (surface === 'home' && querySession) {
    initConversation(querySession);
  }
  startRefresh();
}

// Cancel timers when the page goes away; resume if restored from bfcache.
window.addEventListener('pagehide', () => {
  stopRefresh();
  stopPolling();
});
window.addEventListener('pageshow', e => {
  if (e.persisted) {
    startRefresh();
    const id = guard.current().id;
    if (id) {
      void selectSession(id);
    }
  }
});

void main();
