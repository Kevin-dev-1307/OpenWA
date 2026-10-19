import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { AlertCircle, Info, Loader2, RefreshCw, SquareKanban, Tag } from 'lucide-react';
import { labelApi, sessionApi, type Chat } from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { useRole } from '../hooks/useRole';
import { useProfilePictures } from '../hooks/useProfilePictures';
import { PageHeader } from '../components/PageHeader';
import ChatAvatar from '../components/chats/ChatAvatar';
import SessionSelect from '../components/chats/SessionSelect';
import {
  UNLABELED,
  applyMove,
  boardColumns,
  buildLabelBoard,
  planMove,
  type BoardColumn,
  type LabelBoardData,
} from '../utils/labelBoard';
import './Board.css';

// Polled while the page is visible: the gateway emits no event when a label changes on the phone.
const BOARD_REFRESH_MS = 30_000;

const boardKey = (sessionId: string) => ['labelBoard', sessionId] as const;

/** Labels, each label's chats, and the session's chat list, in one snapshot. */
async function loadBoard(sessionId: string): Promise<LabelBoardData> {
  const labels = await labelApi.list(sessionId);
  // A personal (non-Business) account has no labels: nothing else to read.
  if (labels.length === 0) return buildLabelBoard([], [], []);
  const [chatsByLabel, allChats] = await Promise.all([
    Promise.all(labels.map(label => labelApi.getChats(sessionId, label.id))),
    sessionApi.getChats(sessionId),
  ]);
  return buildLabelBoard(labels, chatsByLabel, allChats);
}

const statusOf = (err: unknown): number | undefined => (err as { status?: number } | null)?.status;

/** A card picked up from the keyboard: where it came from and the column it would land in. */
interface KeyboardGrab {
  chatId: string;
  from: string;
  target: string;
}

export function Board() {
  const { t, i18n } = useTranslation();
  useDocumentTitle(t('nav.board'));
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { error: showErrorToast } = useToast();
  const { canWrite, engineType } = useRole();
  const instructionsId = useId();

  // Same session source as the Chats page: only a ready session can answer label reads.
  const sessionsQuery = useQuery({
    queryKey: ['sessions', 'ready'],
    queryFn: async () => (await sessionApi.list()).filter(s => s.status === 'ready'),
  });
  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
  const [pickedSessionId, setPickedSessionId] = useState('');
  const selectedSessionId = sessions.some(s => s.id === pickedSessionId) ? pickedSessionId : (sessions[0]?.id ?? '');

  // Baileys has no label query at all (every read answers 501), so the board is not even requested.
  const engineUnsupported = engineType === 'baileys';
  const boardQuery = useQuery({
    queryKey: boardKey(selectedSessionId),
    queryFn: () => loadBoard(selectedSessionId),
    enabled: Boolean(selectedSessionId) && !engineUnsupported,
    refetchInterval: BOARD_REFRESH_MS,
    retry: false,
  });
  const columns = useMemo(() => (boardQuery.data ? boardColumns(boardQuery.data) : []), [boardQuery.data]);

  // One batch request for every card on the board, newest columns first (the hook caps it at 50).
  const cardIds = useMemo(() => [...new Set(columns.flatMap(c => c.chats.map(chat => chat.id)))], [columns]);
  const pictures = useProfilePictures(selectedSessionId || undefined, cardIds);

  const [announcement, setAnnouncement] = useState('');
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [grab, setGrab] = useState<KeyboardGrab | null>(null);
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  // The card a mouse drag carries. A ref, not dataTransfer: the browser hides dataTransfer during dragover.
  const dragRef = useRef<{ chatId: string; from: string } | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);

  const columnName = useCallback(
    (column: BoardColumn | undefined) => (column?.label ? column.label.name : t('board.unlabeled')),
    [t],
  );
  const chatName = (chat: Chat) => chat.name || chat.id.split('@')[0];

  const formatChatTime = useCallback(
    (timestamp?: number) => {
      if (!timestamp) return '';
      const date = new Date(timestamp * 1000);
      const today = new Date();
      if (date.toDateString() === today.toDateString()) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      if (date.toDateString() === yesterday.toDateString()) return t('chats.yesterday');
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    },
    [t],
  );

  // A keyboard move re-mounts the card in its new column; focus follows it once that column renders.
  const focusAfterRenderRef = useRef<{ columnId: string; chatId: string } | null>(null);
  const focusCard = (columnId: string, chatId: string) => {
    focusAfterRenderRef.current = { columnId, chatId };
  };
  useEffect(() => {
    const wanted = focusAfterRenderRef.current;
    if (!wanted) return;
    const card = Array.from(boardRef.current?.querySelectorAll<HTMLElement>('[data-card-chat]') ?? []).find(
      el => el.dataset.cardChat === wanted.chatId && el.dataset.cardColumn === wanted.columnId,
    );
    // One attempt: a card dropped on "no label" that still carries another label has no card there.
    focusAfterRenderRef.current = null;
    card?.focus();
  }, [columns]);

  // Optimistic move: the board shows the result at once, the label writes follow, and a failed write
  // puts the card back. Only the source label is swapped for the target; the chat keeps any other.
  const moveCard = async (chatId: string, from: string, to: string, { refocus = false } = {}) => {
    const sessionId = selectedSessionId;
    const key = boardKey(sessionId);
    const data = queryClient.getQueryData<LabelBoardData>(key);
    if (!data || !canWrite) return;
    const plan = planMove(data, chatId, from, to);
    if (!plan) return;
    const chat = data.chats[chatId];
    const target = columnName(boardColumns(data).find(c => c.id === to));
    // A poll landing mid-write would paint the pre-move snapshot over the optimistic one.
    await queryClient.cancelQueries({ queryKey: key });
    queryClient.setQueryData<LabelBoardData>(key, current => (current ? applyMove(current, chatId, plan) : current));
    // A keyboard drop keeps focus on the card it moved; dropping on "no label" while the chat keeps
    // another label leaves no card there, so focus stays where the browser puts it.
    if (refocus) focusCard(to, chatId);
    setPending(prev => new Set(prev).add(chatId));
    try {
      if (plan.add) await labelApi.addToChat(sessionId, chatId, plan.add);
      if (plan.remove) {
        try {
          await labelApi.removeFromChat(sessionId, chatId, plan.remove);
        } catch (err) {
          // Undo the half-applied move so the chat does not end up carrying both labels.
          if (plan.add) await labelApi.removeFromChat(sessionId, chatId, plan.add).catch(() => undefined);
          throw err;
        }
      }
      setAnnouncement(t('board.dropped', { chat: chat ? chatName(chat) : chatId, column: target }));
    } catch (err) {
      queryClient.setQueryData<LabelBoardData>(key, current =>
        current ? applyMove(current, chatId, { add: plan.remove, remove: plan.add }) : current,
      );
      if (refocus) focusCard(from, chatId);
      // The gateway's own words, e.g. a 403 naming the chat a scoped key may not touch.
      showErrorToast(t('board.moveFailed'), err instanceof Error ? err.message : undefined);
      // The toast region is itself a live region, so the failure is not announced twice.
      setAnnouncement('');
    } finally {
      setPending(prev => {
        const next = new Set(prev);
        next.delete(chatId);
        return next;
      });
    }
  };

  const openChat = (chat: Chat) => {
    navigate(`/chats?session=${encodeURIComponent(selectedSessionId)}&chat=${encodeURIComponent(chat.id)}`);
  };

  // --- Mouse / touch-pad drag (HTML5) ---
  const onCardDragStart = (e: DragEvent<HTMLElement>, chatId: string, from: string) => {
    dragRef.current = { chatId, from };
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', chatId);
    }
  };
  const onCardDragEnd = () => {
    dragRef.current = null;
    setDragOver(null);
  };
  const onColumnDragOver = (e: DragEvent<HTMLElement>, columnId: string) => {
    if (!dragRef.current) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (dragOver !== columnId) setDragOver(columnId);
  };
  const onColumnDragLeave = (e: DragEvent<HTMLElement>, columnId: string) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(current => (current === columnId ? null : current));
  };
  const onColumnDrop = (e: DragEvent<HTMLElement>, columnId: string) => {
    e.preventDefault();
    const drag = dragRef.current;
    dragRef.current = null;
    setDragOver(null);
    if (drag) void moveCard(drag.chatId, drag.from, columnId);
  };

  // --- Keyboard drag: Space picks up, arrows choose a column, Space/Enter drops, Escape cancels ---
  const onCardKeyDown = (e: KeyboardEvent<HTMLElement>, chat: Chat, columnId: string) => {
    if (grab && grab.chatId === chat.id && grab.from === columnId) {
      const index = columns.findIndex(c => c.id === grab.target);
      // Columns run with the reading direction, so the arrows mirror under RTL.
      const forward = i18n.dir() === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
      const backward = forward === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight';
      if (e.key === forward || e.key === backward) {
        e.preventDefault();
        const next = columns[Math.min(columns.length - 1, Math.max(0, index + (e.key === forward ? 1 : -1)))];
        setGrab({ ...grab, target: next.id });
        setAnnouncement(t('board.over', { column: columnName(next) }));
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        setGrab(null);
        if (grab.target === columnId) {
          setAnnouncement(t('board.cancelled'));
          return;
        }
        void moveCard(chat.id, columnId, grab.target, { refocus: true });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setGrab(null);
        setAnnouncement(t('board.cancelled'));
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      openChat(chat);
    } else if (e.key === ' ' && canWrite && !pending.has(chat.id)) {
      e.preventDefault();
      setGrab({ chatId: chat.id, from: columnId, target: columnId });
      setAnnouncement(
        t('board.pickedUp', { chat: chatName(chat), column: columnName(columns.find(c => c.id === columnId)) }),
      );
    }
  };

  const loadError = boardQuery.error;
  const loadStatus = statusOf(loadError);

  const renderState = (icon: ReactNode, title: string, desc: ReactNode, retry = false) => (
    <div className="board-state" role={retry ? 'alert' : undefined}>
      {icon}
      <h3>{title}</h3>
      <p>{desc}</p>
      {retry && (
        <button type="button" className="btn-secondary" onClick={() => void boardQuery.refetch()}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );

  let body: ReactNode;
  if (sessionsQuery.isLoading) {
    body = (
      <div className="board-state">
        <Loader2 className="animate-spin" size={32} />
        <p>{t('common.loading')}</p>
      </div>
    );
  } else if (sessions.length === 0) {
    body = renderState(
      <AlertCircle size={48} className="text-warn" />,
      t('chats.noSessionsTitle'),
      <Trans i18nKey="chats.noSessionsDesc">
        Please connect a WhatsApp session from the <strong>Sessions</strong> menu first to use the chat feature.
      </Trans>,
    );
  } else if (engineUnsupported || loadStatus === 501) {
    body = renderState(
      <Info size={48} className="text-muted" />,
      t('board.notSupportedTitle'),
      t('board.notSupportedDesc'),
    );
  } else if (boardQuery.isLoading) {
    body = (
      <div className="board-state">
        <Loader2 className="animate-spin" size={32} />
        <p>{t('common.loading')}</p>
      </div>
    );
  } else if (loadError) {
    body =
      loadStatus === 403
        ? renderState(
            <AlertCircle size={48} className="text-warn" />,
            t('board.forbiddenTitle'),
            t('board.forbiddenDesc'),
          )
        : renderState(
            <AlertCircle size={48} className="text-warn" />,
            t('board.errorTitle'),
            <>
              {t('board.errorDesc')}
              {loadError instanceof Error && loadError.message && (
                <span className="board-state-detail">{loadError.message}</span>
              )}
            </>,
            true,
          );
  } else if ((boardQuery.data?.labels.length ?? 0) === 0) {
    body = renderState(<Tag size={48} className="text-muted" />, t('board.emptyTitle'), t('board.emptyDesc'));
  } else {
    body = (
      <div className="board-columns" ref={boardRef}>
        {columns.map(column => {
          const name = columnName(column);
          const isTarget = dragOver === column.id || (grab !== null && grab.target === column.id);
          return (
            <section
              key={column.id}
              className={`board-column ${isTarget ? 'drop-target' : ''} ${column.id === UNLABELED ? 'unlabeled' : ''}`}
              aria-label={t('board.columnLabel', { column: name, total: column.chats.length })}
              data-column={column.id}
              onDragOver={e => onColumnDragOver(e, column.id)}
              onDragLeave={e => onColumnDragLeave(e, column.id)}
              onDrop={e => onColumnDrop(e, column.id)}
            >
              <header className="board-column-header">
                <span
                  className="board-column-swatch"
                  style={column.label ? { background: column.label.hexColor } : undefined}
                  aria-hidden="true"
                />
                <h2 className="board-column-name" title={name}>
                  {name}
                </h2>
                <span className="board-column-count" aria-hidden="true">
                  {column.chats.length}
                </span>
              </header>
              {column.chats.length === 0 ? (
                <p className="board-column-empty">{t('board.emptyColumn')}</p>
              ) : (
                <ul className="board-cards">
                  {column.chats.map(chat => {
                    const grabbed = grab?.chatId === chat.id && grab.from === column.id;
                    const busy = pending.has(chat.id);
                    return (
                      <li key={chat.id}>
                        <div
                          role="button"
                          tabIndex={0}
                          className={`board-card ${grabbed ? 'grabbed' : ''} ${busy ? 'pending' : ''}`}
                          data-card-chat={chat.id}
                          data-card-column={column.id}
                          draggable={canWrite && !busy}
                          aria-describedby={canWrite ? instructionsId : undefined}
                          aria-busy={busy || undefined}
                          title={t('board.openChat', { chat: chatName(chat) })}
                          onClick={() => openChat(chat)}
                          onKeyDown={e => onCardKeyDown(e, chat, column.id)}
                          onBlur={() => {
                            if (grabbed) setGrab(null);
                          }}
                          onDragStart={e => onCardDragStart(e, chat.id, column.id)}
                          onDragEnd={onCardDragEnd}
                        >
                          <ChatAvatar pictureUrl={pictures.data?.[chat.id]} kind={chat.kind} />
                          <div className="board-card-info">
                            <div className="board-card-top">
                              <span className="board-card-name">{chatName(chat)}</span>
                              {chat.timestamp ? (
                                <span className="board-card-time">{formatChatTime(chat.timestamp)}</span>
                              ) : null}
                            </div>
                            <span className="board-card-snippet">
                              {chat.lastMessage ||
                                (!chat.timestamp && <span className="no-message">{t('chats.noMessageYet')}</span>)}
                            </span>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    );
  }

  const showBoardChrome = sessions.length > 0 && !sessionsQuery.isLoading;

  return (
    <div className="board-page">
      <PageHeader
        title={t('nav.board')}
        subtitle={t('board.subtitle')}
        actions={
          showBoardChrome &&
          !engineUnsupported && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void boardQuery.refetch()}
              disabled={boardQuery.isFetching}
            >
              <RefreshCw size={16} className={boardQuery.isFetching ? 'animate-spin' : undefined} />
              {t('common.refresh')}
            </button>
          )
        }
      />

      {showBoardChrome && (
        <div className="board-toolbar">
          <SessionSelect
            id="board-session"
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            onSelectSession={id => {
              setGrab(null);
              setPickedSessionId(id);
            }}
          />
          {engineType === 'whatsapp-web.js' && (
            <p className="board-notice" role="note">
              <Info size={16} aria-hidden="true" />
              <span>{t('board.wwjsNotice')}</span>
            </p>
          )}
          {!canWrite && (
            <p className="board-notice" role="note">
              <SquareKanban size={16} aria-hidden="true" />
              <span>{t('board.readOnly')}</span>
            </p>
          )}
        </div>
      )}

      {body}

      <p id={instructionsId} className="board-sr-only">
        {t('board.dragInstructions')}
      </p>
      <div className="board-sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}
