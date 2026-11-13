'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const BgRemoval = require('../js/bg-removal.js');

function makeImage(w, h, [r, g, b, a = 255]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
  }
  return { width: w, height: h, data };
}

function setPixel(img, x, y, [r, g, b, a = 255]) {
  const i = (y * img.width + x) * 4;
  img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = a;
}

function getPixel(img, x, y) {
  const i = (y * img.width + x) * 4;
  return Array.from(img.data.slice(i, i + 4));
}

function fillRect(img, x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPixel(img, x, y, color);
}

// deterministic pseudo-random noise
function rng(seed) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

test('detects a noisy white background around an object', () => {
  const img = makeImage(200, 150, [255, 255, 255]);
  const rand = rng(42);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 255 - Math.floor(rand() * 6);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
  }
  fillRect(img, 50, 40, 100, 70, [200, 20, 20]);
  const res = BgRemoval.detectBackgroundColor(img);
  assert.ok(res.color);
  assert.ok(BgRemoval.colorDistance(res.color.r, res.color.g, res.color.b, 253, 253, 253) < 2, res.hex);
  assert.match(res.hex, /^#[0-9A-F]{6}$/);
  assert.ok(res.confidence > 0.95, `confidence ${res.confidence}`);
});

test('ignores an object that touches the edge', () => {
  const img = makeImage(120, 100, [0x33, 0x66, 0xcc]);
  fillRect(img, 0, 20, 40, 50, [0, 0, 0]); // touches the left edge
  const res = BgRemoval.detectBackgroundColor(img);
  assert.equal(res.hex, '#3366CC');
  assert.ok(res.confidence > 0.8 && res.confidence < 1);
});

test('reports a fully transparent edge as having no color', () => {
  const img = makeImage(50, 50, [0, 0, 0, 0]);
  fillRect(img, 10, 10, 30, 30, [255, 0, 0]);
  const res = BgRemoval.detectBackgroundColor(img);
  assert.equal(res.color, null);
  assert.equal(res.transparentRatio, 1);
});

test('connected mode keeps background-colored holes inside objects', () => {
  const img = makeImage(40, 40, [255, 255, 255]);
  fillRect(img, 10, 10, 20, 20, [0, 0, 0]);
  fillRect(img, 15, 15, 10, 10, [255, 255, 255]); // hole enclosed by the black ring
  const stats = BgRemoval.removeBackground(img, { r: 255, g: 255, b: 255 }, { soften: false });
  assert.equal(getPixel(img, 0, 0)[3], 0);
  assert.equal(getPixel(img, 5, 35)[3], 0);
  assert.deepEqual(getPixel(img, 20, 20), [255, 255, 255, 255]);
  assert.deepEqual(getPixel(img, 12, 12), [0, 0, 0, 255]);
  assert.equal(stats.removed, 40 * 40 - 20 * 20);
});

test('global mode also removes the holes', () => {
  const img = makeImage(40, 40, [255, 255, 255]);
  fillRect(img, 10, 10, 20, 20, [0, 0, 0]);
  fillRect(img, 15, 15, 10, 10, [255, 255, 255]);
  BgRemoval.removeBackground(img, { r: 255, g: 255, b: 255 }, { mode: 'global', soften: false });
  assert.equal(getPixel(img, 20, 20)[3], 0);
  assert.deepEqual(getPixel(img, 12, 12), [0, 0, 0, 255]);
});

test('tolerance decides which near-background pixels go', () => {
  const img = makeImage(10, 10, [255, 255, 255]);
  setPixel(img, 0, 0, [245, 245, 245]); // distance ~3.9
  setPixel(img, 9, 9, [200, 200, 200]); // distance ~12.5
  BgRemoval.removeBackground(img, { r: 255, g: 255, b: 255 }, { tolerance: 5, soften: false });
  assert.equal(getPixel(img, 0, 0)[3], 0);
  assert.equal(getPixel(img, 9, 9)[3], 255);
});

test('softening subtracts the background from anti-aliased edge pixels', () => {
  const img = makeImage(20, 20, [255, 255, 255]);
  fillRect(img, 6, 6, 8, 8, [255, 0, 0]);
  // a ring of 50% red-over-white around the red square
  for (let i = 5; i <= 14; i++) {
    for (const [x, y] of [[i, 5], [i, 14], [5, i], [14, i]]) setPixel(img, x, y, [255, 128, 128]);
  }
  const stats = BgRemoval.removeBackground(img, { r: 255, g: 255, b: 255 }, { tolerance: 10 });
  const edge = getPixel(img, 5, 10);
  assert.equal(edge[0], 255);
  assert.ok(edge[1] <= 2 && edge[2] <= 2, `edge color ${edge}`);
  assert.ok(Math.abs(edge[3] - 127) <= 2, `edge alpha ${edge[3]}`);
  assert.deepEqual(getPixel(img, 10, 10), [255, 0, 0, 255]); // interior untouched
  assert.ok(stats.softened > 0);
});

test('edgeMatchRatio measures a user-picked color', () => {
  const img = makeImage(30, 30, [10, 200, 10]);
  fillRect(img, 0, 0, 30, 15, [250, 250, 250]);
  const ratio = BgRemoval.edgeMatchRatio(img, { r: 10, g: 200, b: 10 });
  assert.ok(ratio > 0.3 && ratio < 0.7, `ratio ${ratio}`);
});
