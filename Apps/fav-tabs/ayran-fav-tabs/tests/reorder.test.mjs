import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  moveSelectedBy,
  moveSelectedToStart,
  moveSelectedToEnd,
  moveSelectedBefore,
  applyOrder,
} from '../src/shared/reorder.js';

const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
const s = (...x) => new Set(x);

test('moveSelectedBy shifts by one', () => {
  assert.deepEqual(moveSelectedBy(ids, s('c'), -1), ['a', 'c', 'b', 'd', 'e', 'f']);
  assert.deepEqual(moveSelectedBy(ids, s('c'), 1), ['a', 'b', 'd', 'c', 'e', 'f']);
  assert.deepEqual(moveSelectedBy(ids, s('b', 'd'), -1), ['b', 'a', 'd', 'c', 'e', 'f']);
  assert.deepEqual(moveSelectedBy(ids, s('b', 'd'), 1), ['a', 'c', 'b', 'e', 'd', 'f']);
});

test('moveSelectedBy piles up at the edges without overtaking', () => {
  assert.deepEqual(moveSelectedBy(ids, s('a', 'c'), -1), ['a', 'c', 'b', 'd', 'e', 'f']);
  assert.deepEqual(moveSelectedBy(ids, s('b', 'e'), -10), ['b', 'e', 'a', 'c', 'd', 'f']);
  assert.deepEqual(moveSelectedBy(ids, s('b', 'e'), 30), ['a', 'c', 'd', 'f', 'b', 'e']);
  assert.deepEqual(moveSelectedBy(ids, s('f'), 1), ids);
  assert.deepEqual(moveSelectedBy(ids, s('d'), -3), ['d', 'a', 'b', 'c', 'e', 'f']);
});

test('moveSelectedBy with nothing selected returns a copy', () => {
  const out = moveSelectedBy(ids, s(), 1);
  assert.deepEqual(out, ids);
  assert.notEqual(out, ids);
});

test('start / end', () => {
  assert.deepEqual(moveSelectedToStart(ids, s('c', 'e')), ['c', 'e', 'a', 'b', 'd', 'f']);
  assert.deepEqual(moveSelectedToEnd(ids, s('a', 'c')), ['b', 'd', 'e', 'f', 'a', 'c']);
});

test('moveSelectedBefore (drag and drop)', () => {
  assert.deepEqual(moveSelectedBefore(ids, s('e', 'f'), 'b'), ['a', 'e', 'f', 'b', 'c', 'd']);
  assert.deepEqual(moveSelectedBefore(ids, s('a', 'b'), null), ['c', 'd', 'e', 'f', 'a', 'b']);
  assert.deepEqual(moveSelectedBefore(ids, s('a', 'c'), 'e'), ['b', 'd', 'a', 'c', 'e', 'f']);
  // dropping onto a selected item: goes before the next unselected one
  assert.deepEqual(moveSelectedBefore(ids, s('b', 'c'), 'c'), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(moveSelectedBefore(ids, s('a', 'f'), 'f'), ['b', 'c', 'd', 'e', 'a', 'f']);
});

test('applyOrder', () => {
  const items = ids.map((id) => ({ id }));
  assert.deepEqual(
    applyOrder(items, ['c', 'a', 'zzz']).map((x) => x.id),
    ['c', 'a', 'b', 'd', 'e', 'f'],
  );
});
