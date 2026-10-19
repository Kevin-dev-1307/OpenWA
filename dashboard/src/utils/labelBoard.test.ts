import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Chat, Label } from '../services/api';
import { UNLABELED, applyMove, boardColumns, buildLabelBoard, planMove } from './labelBoard.ts';

const chat = (id: string, timestamp: number): Chat => ({
  id,
  name: id,
  isGroup: false,
  kind: 'individual',
  unreadCount: 0,
  timestamp,
  archived: false,
  pinned: false,
  muted: false,
});

const A = chat('a', 300);
const B = chat('b', 200);
const C = chat('c', 100);
const LABELS: Label[] = [
  { id: '1', name: 'One', hexColor: '#111111' },
  { id: '2', name: 'Two', hexColor: '#222222' },
];
const board = () => buildLabelBoard(LABELS, [[A], [B, A]], [C, B, A]);
const ids = (data: ReturnType<typeof board>) =>
  Object.fromEntries(boardColumns(data).map(col => [col.id, col.chats.map(c => c.id)]));

test('columns list each label newest first, then every chat without a label', () => {
  assert.deepEqual(ids(board()), { '1': ['a'], '2': ['a', 'b'], [UNLABELED]: ['c'] });
});

test('a chat only a label lists still gets a card', () => {
  const extra = chat('x', 50);
  const data = buildLabelBoard(LABELS, [[extra], []], [A]);
  assert.deepEqual(ids(data), { '1': ['x'], '2': [], [UNLABELED]: ['a'] });
});

test('a move swaps the source label for the target and keeps the others', () => {
  const data = board();
  assert.deepEqual(planMove(data, 'a', '1', '2'), { add: null, remove: '1' });
  assert.deepEqual(planMove(data, 'b', '2', '1'), { add: '1', remove: '2' });
  assert.deepEqual(planMove(data, 'c', UNLABELED, '2'), { add: '2', remove: null });
  assert.deepEqual(planMove(data, 'a', '2', UNLABELED), { add: null, remove: '2' });
  assert.equal(planMove(data, 'a', '1', '1'), null);
});

test('applying a move keeps the target column newest first, and the inverse plan restores it', () => {
  const data = board();
  const plan = planMove(data, 'c', UNLABELED, '2')!;
  const moved = applyMove(data, 'c', plan);
  assert.deepEqual(ids(moved), { '1': ['a'], '2': ['a', 'b', 'c'], [UNLABELED]: [] });
  const back = applyMove(moved, 'c', { add: plan.remove, remove: plan.add });
  assert.deepEqual(ids(back), ids(data));

  const swap = planMove(data, 'b', '2', '1')!;
  assert.deepEqual(ids(applyMove(data, 'b', swap)), { '1': ['a', 'b'], '2': ['a'], [UNLABELED]: ['c'] });
});
