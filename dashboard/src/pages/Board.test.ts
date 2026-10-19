// Render tests for the label board under the bare `node --test` runner, built like Chats.test.ts:
// the page is wrapped in the providers App.tsx uses (plus a MemoryRouter, since a card opens the chat
// through the router), and the backend is stubbed at the fetch layer. Every request is recorded so a
// test asserts the label writes a move sends, not only the optimistic card.
import '../test-helpers/register-hooks.ts';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Chat, Label, Session } from '../services/api';
import type { installJsdomGlobals as installJsdomGlobalsFn } from '../test-helpers/jsdom.ts';

// ── Fixtures + fetch stub ────────────────────────────────────────────────────

const SESSION: Session = {
  id: 'session-1',
  name: 'Main',
  status: 'ready',
  phone: '15551234567',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const chat = (id: string, name: string, timestamp: number, lastMessage: string): Chat => ({
  id,
  name,
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp,
  lastMessage,
  archived: false,
  pinned: false,
  muted: false,
});

const ALICE = chat('15550001111@c.us', 'Alice', 1_700_000_300, 'quiero una invitación');
const BOB = chat('15550002222@c.us', 'Bob', 1_700_000_200, 'ya pagué');
const CAROL = chat('15550003333@c.us', 'Carol', 1_700_000_100, 'hola');

const LABELS: Label[] = [
  { id: '1', name: 'Nuevo cliente', hexColor: '#ff9485' },
  { id: '2', name: 'Pagado', hexColor: '#64c4ff' },
];

let labels: Label[] = LABELS;
// label id -> chats carrying it. Alice carries both labels, Bob only "Pagado", Carol none.
let byLabel: Record<string, Chat[]> = {};
let labelsStatus = 200;
let writeStatus = 200;
let engineType = 'whatsapp-web.js';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

interface FetchCall {
  method: string;
  path: string;
  body?: unknown;
}
const fetchCalls: FetchCall[] = [];
const writes = () => fetchCalls.filter(c => c.method !== 'GET');

function installFetchStub(): void {
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    fetchCalls.push({ method, path, body });
    const base = `/api/sessions/${SESSION.id}`;

    if (method === 'GET' && path === '/api/sessions') return Promise.resolve(jsonResponse([SESSION]));
    if (method === 'GET' && path === `${base}/labels`) {
      if (labelsStatus !== 200) return Promise.resolve(jsonResponse({ message: 'nope' }, labelsStatus));
      return Promise.resolve(jsonResponse(labels));
    }
    const chatsOf = path.match(new RegExp(`^${base}/labels/([^/]+)/chats$`));
    if (method === 'GET' && chatsOf)
      return Promise.resolve(jsonResponse(byLabel[decodeURIComponent(chatsOf[1])] ?? []));
    if (method === 'GET' && path === `${base}/chats`) return Promise.resolve(jsonResponse([ALICE, BOB, CAROL]));
    if (method === 'GET' && path.startsWith(`${base}/contacts/profile-pictures`)) {
      return Promise.resolve(jsonResponse({ pictures: {} }));
    }
    if ((method === 'POST' || method === 'DELETE') && path.startsWith(`${base}/labels/chat/`)) {
      if (writeStatus !== 200) {
        return Promise.resolve(jsonResponse({ message: 'Chat not allowed for this key' }, writeStatus));
      }
      return Promise.resolve(jsonResponse({ success: true }));
    }
    return Promise.resolve(jsonResponse({ message: `unstubbed ${method} ${path}` }, 404));
  };
}

// ── Harness ──────────────────────────────────────────────────────────────────

type RTL = typeof import('@testing-library/react');
type Router = typeof import('react-router-dom');
let rtl: RTL;
let router: Router;
let Board: (typeof import('./Board.tsx'))['Board'];
let RoleProvider: (typeof import('../components/RoleProvider.tsx'))['RoleProvider'];
let ToastProvider: (typeof import('../components/Toast.tsx'))['ToastProvider'];
let installJsdomGlobals: typeof installJsdomGlobalsFn;
let queryClient: QueryClient | undefined;

before(async () => {
  ({ installJsdomGlobals } = await import('../test-helpers/jsdom.ts'));
  await installJsdomGlobals();
  installFetchStub();
  window.sessionStorage.setItem('openwa_api_key', 'test-key');
  const { i18nReady } = await import('../i18n/index.ts');
  await i18nReady;
  rtl = await import('@testing-library/react');
  router = await import('react-router-dom');
  ({ RoleProvider } = await import('../components/RoleProvider.tsx'));
  ({ ToastProvider } = await import('../components/Toast.tsx'));
  ({ Board } = await import('./Board.tsx'));
});

afterEach(async () => {
  rtl.cleanup();
  await queryClient?.cancelQueries();
  queryClient?.clear();
  queryClient = undefined;
  fetchCalls.length = 0;
  labels = LABELS;
  labelsStatus = 200;
  writeStatus = 200;
  engineType = 'whatsapp-web.js';
});

/** Where the router sits, rendered on the Chats route so a test can read the link a card followed. */
function ChatsProbe() {
  const location = router.useLocation();
  return createElement('div', { 'data-testid': 'chats-route' }, `${location.pathname}${location.search}`);
}

function renderBoard(role: 'admin' | 'operator' | 'viewer' = 'operator'): ReturnType<RTL['render']> {
  window.sessionStorage.setItem('openwa_user_role', role);
  window.sessionStorage.setItem('openwa_engine_type', engineType);
  byLabel = { '1': [ALICE], '2': [ALICE, BOB] };
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
  const { MemoryRouter, Routes, Route } = router;
  return rtl.render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        RoleProvider,
        null,
        createElement(
          ToastProvider,
          null,
          createElement(
            MemoryRouter,
            { initialEntries: ['/board'] },
            createElement(
              Routes,
              null,
              createElement(Route, { path: '/board', element: createElement(Board) }),
              createElement(Route, { path: '/chats', element: createElement(ChatsProbe) }),
            ),
          ),
        ),
      ),
    ),
  );
}

const column = (container: HTMLElement, id: string) => container.querySelector(`[data-column="${id}"]`) as HTMLElement;
const cardIn = (container: HTMLElement, columnId: string, chatId: string) =>
  column(container, columnId)?.querySelector(`[data-card-chat="${chatId}"]`) as HTMLElement | null;
const namesIn = (container: HTMLElement, columnId: string) =>
  Array.from(column(container, columnId).querySelectorAll('.board-card-name')).map(n => n.textContent);

async function waitForBoard(container: HTMLElement): Promise<void> {
  await rtl.waitFor(() => assert.ok(column(container, '__unlabeled__'), 'board columns rendered'));
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('renders one column per label plus "No label", with each chat under every label it carries', async () => {
  const { container } = renderBoard();
  await waitForBoard(container);

  const headers = Array.from(container.querySelectorAll('.board-column-name')).map(h => h.textContent);
  assert.deepEqual(headers, ['Nuevo cliente', 'Pagado', 'No label']);
  assert.deepEqual(namesIn(container, '1'), ['Alice']);
  assert.deepEqual(namesIn(container, '2'), ['Alice', 'Bob']);
  assert.deepEqual(namesIn(container, '__unlabeled__'), ['Carol']);

  // The label colour reaches its column; the card carries the snippet and the time.
  const swatch = column(container, '1').querySelector('.board-column-swatch') as HTMLElement;
  assert.equal(swatch.style.background, 'rgb(255, 148, 133)');
  assert.ok(rtl.within(column(container, '2')).getByText('ya pagué'));
  // whatsapp-web.js cannot edit labels, so the page points at the phone app.
  assert.ok(rtl.screen.getByText('Create or rename labels from the WhatsApp Business app on your phone.'));
});

test('dragging a card from one label to another swaps only that label', async () => {
  const { container } = renderBoard();
  await waitForBoard(container);
  const { fireEvent, waitFor } = rtl;

  fireEvent.dragStart(cardIn(container, '1', ALICE.id)!);
  fireEvent.dragOver(column(container, '__unlabeled__'));
  fireEvent.drop(column(container, '__unlabeled__'));
  // Alice still carries "Pagado", so "No label" stays empty of her; only label 1 is removed.
  await waitFor(() => assert.deepEqual(namesIn(container, '1'), []));
  assert.deepEqual(namesIn(container, '2'), ['Alice', 'Bob']);
  assert.deepEqual(namesIn(container, '__unlabeled__'), ['Carol']);
  await waitFor(() =>
    assert.deepEqual(writes(), [
      {
        method: 'DELETE',
        path: `/api/sessions/session-1/labels/chat/${encodeURIComponent(ALICE.id)}/1`,
        body: undefined,
      },
    ]),
  );
});

test('moving an unlabeled chat onto a label adds it, and onto "No label" removes the source label', async () => {
  const { container } = renderBoard();
  await waitForBoard(container);
  const { fireEvent, waitFor } = rtl;

  fireEvent.dragStart(cardIn(container, '__unlabeled__', CAROL.id)!);
  fireEvent.dragOver(column(container, '1'));
  fireEvent.drop(column(container, '1'));
  await waitFor(() => assert.deepEqual(namesIn(container, '1'), ['Alice', 'Carol']));
  assert.deepEqual(namesIn(container, '__unlabeled__'), []);
  await waitFor(() => assert.equal(writes().length, 1));
  assert.deepEqual(writes()[0], {
    method: 'POST',
    path: `/api/sessions/session-1/labels/chat/${encodeURIComponent(CAROL.id)}`,
    body: { labelId: '1' },
  });

  fetchCalls.length = 0;
  fireEvent.dragStart(cardIn(container, '2', BOB.id)!);
  fireEvent.dragOver(column(container, '1'));
  fireEvent.drop(column(container, '1'));
  await waitFor(() => assert.deepEqual(namesIn(container, '1'), ['Alice', 'Bob', 'Carol']));
  assert.deepEqual(namesIn(container, '2'), ['Alice']);
  await waitFor(() => assert.equal(writes().length, 2));
  assert.deepEqual(
    writes().map(w => `${w.method} ${w.path}`),
    [
      `POST /api/sessions/session-1/labels/chat/${encodeURIComponent(BOB.id)}`,
      `DELETE /api/sessions/session-1/labels/chat/${encodeURIComponent(BOB.id)}/2`,
    ],
  );
});

test('a failed write puts the card back and shows the error', async () => {
  writeStatus = 403;
  const { container } = renderBoard();
  await waitForBoard(container);
  const { fireEvent, waitFor, screen } = rtl;

  fireEvent.dragStart(cardIn(container, '__unlabeled__', CAROL.id)!);
  fireEvent.dragOver(column(container, '2'));
  fireEvent.drop(column(container, '2'));

  await screen.findByText("Couldn't move the chat");
  await waitFor(() => assert.deepEqual(namesIn(container, '__unlabeled__'), ['Carol']));
  assert.deepEqual(namesIn(container, '2'), ['Alice', 'Bob']);
  assert.ok(screen.getByText('Chat not allowed for this key'));
});

test('the keyboard moves a card: Space picks up, an arrow picks the column, Space drops', async () => {
  const { container } = renderBoard();
  await waitForBoard(container);
  const { fireEvent, waitFor, screen } = rtl;

  const card = cardIn(container, '2', BOB.id)!;
  card.focus();
  fireEvent.keyDown(card, { key: ' ' });
  await screen.findByText('Picked up Bob in Pagado.');
  fireEvent.keyDown(card, { key: 'ArrowRight' });
  await screen.findByText('Over No label.');
  assert.ok(column(container, '__unlabeled__').classList.contains('drop-target'));
  fireEvent.keyDown(card, { key: ' ' });

  await waitFor(() => assert.deepEqual(namesIn(container, '__unlabeled__'), ['Bob', 'Carol']));
  assert.deepEqual(namesIn(container, '2'), ['Alice']);
  await screen.findByText('Moved Bob to No label.');
  // Focus follows the card into its new column, so the next key press acts on it.
  assert.equal(document.activeElement, cardIn(container, '__unlabeled__', BOB.id));
});

test('Escape cancels a keyboard move without writing anything', async () => {
  const { container } = renderBoard();
  await waitForBoard(container);
  const { fireEvent, screen } = rtl;

  const card = cardIn(container, '1', ALICE.id)!;
  fireEvent.keyDown(card, { key: ' ' });
  fireEvent.keyDown(card, { key: 'ArrowRight' });
  fireEvent.keyDown(card, { key: 'Escape' });
  await screen.findByText('Move cancelled.');
  assert.deepEqual(writes(), []);
  assert.deepEqual(namesIn(container, '1'), ['Alice']);
});

test('clicking a card opens that chat in the Chats view', async () => {
  const { container } = renderBoard();
  await waitForBoard(container);
  rtl.fireEvent.click(cardIn(container, '__unlabeled__', CAROL.id)!);
  const probe = await rtl.screen.findByTestId('chats-route');
  assert.equal(probe.textContent, `/chats?session=session-1&chat=${encodeURIComponent(CAROL.id)}`);
});

test('a read-only key sees the board but cannot drag', async () => {
  const { container } = renderBoard('viewer');
  await waitForBoard(container);
  assert.equal(cardIn(container, '1', ALICE.id)!.getAttribute('draggable'), 'false');
  assert.ok(rtl.screen.getByText('This key is read-only: moving cards needs an operator key.'));
  rtl.fireEvent.keyDown(cardIn(container, '1', ALICE.id)!, { key: ' ' });
  assert.equal(container.querySelector('.board-card.grabbed'), null);
});

test('Baileys shows the engine notice and never asks for labels', async () => {
  engineType = 'baileys';
  renderBoard();
  await rtl.screen.findByText('Not available with this engine');
  assert.equal(
    fetchCalls.some(c => c.path.includes('/labels')),
    false,
  );
});

test('a 501 from the label route shows the engine notice', async () => {
  labelsStatus = 501;
  renderBoard();
  await rtl.screen.findByText('Not available with this engine');
});

test('a 403 on the labels shows the access state instead of crashing', async () => {
  labelsStatus = 403;
  renderBoard();
  await rtl.screen.findByText('No access to labels');
});

test('another load failure shows the error state with a retry', async () => {
  labelsStatus = 500;
  renderBoard();
  await rtl.screen.findByText("Couldn't load the board");
  labelsStatus = 200;
  rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Retry' }));
  await rtl.screen.findByText('Nuevo cliente');
});

test('an account with no labels shows the empty state', async () => {
  labels = [];
  renderBoard();
  await rtl.screen.findByText('No labels yet');
});
