import type { Chat, Label } from '../services/api';

/** The id of the fixed column holding every chat that carries no label. */
export const UNLABELED = '__unlabeled__';

/**
 * Everything the board renders for one session: the account's labels, which chats carry each one,
 * and the chat summaries by id. A chat with several labels is listed under each of them.
 */
export interface LabelBoardData {
  labels: Label[];
  /** label id -> chat ids carrying it, newest first. */
  membership: Record<string, string[]>;
  chats: Record<string, Chat>;
  /** Every chat id the session lists, newest first: the source of the "no label" column. */
  order: string[];
}

export interface BoardColumn {
  id: string;
  label: Label | null;
  chats: Chat[];
}

const newestFirst = (a: Chat, b: Chat) => (b.timestamp || 0) - (a.timestamp || 0);

/** Assemble the board from the label list, each label's chats, and the session's chat list. */
export function buildLabelBoard(labels: Label[], chatsByLabel: Chat[][], allChats: Chat[]): LabelBoardData {
  const chats: Record<string, Chat> = {};
  for (const chat of allChats) chats[chat.id] = chat;
  const membership: Record<string, string[]> = {};
  labels.forEach((label, i) => {
    const rows = [...(chatsByLabel[i] ?? [])].sort(newestFirst);
    for (const chat of rows) chats[chat.id] ??= chat;
    membership[label.id] = rows.map(c => c.id);
  });
  const order = [...allChats].sort(newestFirst).map(c => c.id);
  return { labels, membership, chats, order };
}

/** The columns in display order: one per label, then the fixed "no label" column. */
export function boardColumns(data: LabelBoardData): BoardColumn[] {
  const labeled = new Set<string>();
  const columns: BoardColumn[] = data.labels.map(label => {
    const ids = data.membership[label.id] ?? [];
    ids.forEach(id => labeled.add(id));
    return { id: label.id, label, chats: ids.map(id => data.chats[id]).filter(Boolean) };
  });
  const unlabeled = data.order.filter(id => !labeled.has(id)).map(id => data.chats[id]);
  columns.push({ id: UNLABELED, label: null, chats: unlabeled.filter(Boolean) });
  return columns;
}

/** The label writes a move from one column to another needs, in the order they are sent. */
export interface MovePlan {
  add: string | null;
  remove: string | null;
}

/**
 * Moving a card swaps only the source label for the target one; any other label the chat carries
 * stays. Dropping on "no label" only removes the source label. A target the chat already carries
 * (it is listed in that column too) needs no add. Null when there is nothing to write.
 */
export function planMove(data: LabelBoardData, chatId: string, from: string, to: string): MovePlan | null {
  if (from === to) return null;
  const has = (labelId: string) => (data.membership[labelId] ?? []).includes(chatId);
  const add = to !== UNLABELED && !has(to) ? to : null;
  const remove = from !== UNLABELED && has(from) ? from : null;
  if (!add && !remove) return null;
  return { add, remove };
}

/** The board as it reads once a move's writes have landed — what the optimistic update shows. */
export function applyMove(data: LabelBoardData, chatId: string, plan: MovePlan): LabelBoardData {
  const membership = { ...data.membership };
  if (plan.remove) membership[plan.remove] = (membership[plan.remove] ?? []).filter(id => id !== chatId);
  if (plan.add) {
    const chat = data.chats[chatId];
    const ids = (membership[plan.add] ?? []).filter(id => id !== chatId);
    // Keep the column newest-first: the moved card lands where its timestamp puts it.
    const at = ids.findIndex(id => (data.chats[id]?.timestamp || 0) < (chat?.timestamp || 0));
    ids.splice(at === -1 ? ids.length : at, 0, chatId);
    membership[plan.add] = ids;
  }
  return { ...data, membership };
}
