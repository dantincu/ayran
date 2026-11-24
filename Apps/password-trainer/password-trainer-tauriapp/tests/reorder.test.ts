import assert from 'node:assert/strict'
import { test } from 'node:test'
import { moveBlock, moveDown, moveUp, rangeBetween } from '../src/reorder.ts'

const L = ['a', 'b', 'c', 'd', 'e']
const sel = (...s: string[]) => (x: string) => s.includes(x)

test('arrows move the selection one step, blocked at the ends', () => {
  assert.deepEqual(moveUp(L, sel('b', 'd')), ['b', 'a', 'd', 'c', 'e'])
  assert.deepEqual(moveUp(L, sel('a', 'b', 'd')), ['a', 'b', 'd', 'c', 'e'])
  assert.deepEqual(moveDown(L, sel('b', 'e')), ['a', 'c', 'b', 'd', 'e'])
  assert.deepEqual(moveDown(L, sel('d', 'e')), L)
})

test('drag moves a block into a gap, keeping its order', () => {
  assert.deepEqual(moveBlock(L, sel('d'), 0), ['d', 'a', 'b', 'c', 'e'])
  assert.deepEqual(moveBlock(L, sel('a'), 5), ['b', 'c', 'd', 'e', 'a'])
  assert.deepEqual(moveBlock(L, sel('a', 'c'), 4), ['b', 'd', 'a', 'c', 'e'])
  assert.deepEqual(moveBlock(L, sel('b'), 2), L) // dropped where it was
  assert.deepEqual(moveBlock(L, sel('b', 'e'), 3), ['a', 'c', 'b', 'e', 'd'])
})

test('range covers both ends in either direction', () => {
  assert.deepEqual(rangeBetween(L, 3, 1), ['b', 'c', 'd'])
  assert.deepEqual(rangeBetween(L, 2, 2), ['c'])
})
