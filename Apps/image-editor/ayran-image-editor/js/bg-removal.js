/*
 * Background detection and removal.
 *
 * Pure functions working on ImageData-like objects ({ width, height, data: Uint8ClampedArray RGBA }),
 * so they run in the browser (window.BgRemoval) and in Node (require) for the tests.
 *
 * Two steps, as the spec asks:
 *   1. detectBackgroundColor(img)            -> one color (+ how sure we are)
 *   2. removeBackground(img, color, options) -> subtracts that color, once the user confirmed it
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BgRemoval = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_DIST = Math.sqrt(3) * 255;
  /** Pixels with an alpha below this already count as transparent. */
  const TRANSPARENT_ALPHA = 16;
  /** Distance (0..100) under which an edge pixel is said to "match" a color, for the confidence figure. */
  const MATCH_DISTANCE = 10;

  /** Euclidean RGB distance scaled to 0 (same color) .. 100 (black vs white). */
  function colorDistance(r1, g1, b1, r2, g2, b2) {
    const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    return (Math.sqrt(dr * dr + dg * dg + db * db) / MAX_DIST) * 100;
  }

  function toHex(c) {
    return '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  /** Width of the edge band that is sampled: 1px for small images, up to 3px for large ones. */
  function defaultBand(w, h) {
    return Math.max(1, Math.min(3, Math.floor(Math.min(w, h) / 100)));
  }

  /** Calls fn(x, y) once for every pixel within `band` pixels of the image's edges. */
  function forEachEdgePixel(w, h, band, fn) {
    band = Math.max(1, Math.min(band, Math.ceil(Math.min(w, h) / 2)));
    for (let y = 0; y < h; y++) {
      if (y < band || y >= h - band) {
        for (let x = 0; x < w; x++) fn(x, y);
      } else {
        for (let x = 0; x < band; x++) fn(x, y);
        for (let x = Math.max(band, w - band); x < w; x++) fn(x, y);
      }
    }
  }

  function bucketOf(data, i) {
    return ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
  }

  /** Sum of the counts of a 5-bit-per-channel bucket and its 26 neighbours. */
  function neighbourhood(counts, key) {
    const r = key >> 10, g = (key >> 5) & 31, b = key & 31;
    let sum = 0;
    for (let dr = -1; dr <= 1; dr++) {
      const R = r + dr;
      if (R < 0 || R > 31) continue;
      for (let dg = -1; dg <= 1; dg++) {
        const G = g + dg;
        if (G < 0 || G > 31) continue;
        for (let db = -1; db <= 1; db++) {
          const B = b + db;
          if (B < 0 || B > 31) continue;
          sum += counts[(R << 10) | (G << 5) | B];
        }
      }
    }
    return sum;
  }

  function median(hist, n) {
    const half = Math.ceil(n / 2);
    let cum = 0;
    for (let v = 0; v < 256; v++) {
      cum += hist[v];
      if (cum >= half) return v;
    }
    return 255;
  }

  /** Indices (into data) of the opaque edge pixels, plus edge totals. */
  function collectEdge(img, band) {
    const { width: w, height: h, data } = img;
    const opaque = [];
    let total = 0, transparent = 0;
    forEachEdgePixel(w, h, band, (x, y) => {
      const i = (y * w + x) * 4;
      total++;
      if (data[i + 3] < TRANSPARENT_ALPHA) transparent++;
      else opaque.push(i);
    });
    return { opaque, total, transparent };
  }

  /** Share (0..1) of the opaque edge pixels that are within MATCH_DISTANCE of `color`. */
  function edgeMatchRatio(img, color, band) {
    const { opaque } = collectEdge(img, band || defaultBand(img.width, img.height));
    if (!opaque.length) return 0;
    const d = img.data;
    let matching = 0;
    for (const i of opaque) {
      if (colorDistance(d[i], d[i + 1], d[i + 2], color.r, color.g, color.b) <= MATCH_DISTANCE) matching++;
    }
    return matching / opaque.length;
  }

  /**
   * Step 1: find the background color.
   *
   * The background is assumed to be what dominates the image's edges. The opaque edge pixels are
   * grouped into coarse color buckets; the bucket that, together with its neighbours, holds the most
   * pixels wins (neighbours are added so a color sitting on a bucket boundary is not split in two).
   * The result is the per-channel median of the pixels in and around that bucket, which ignores
   * noise and the odd object touching the edge.
   *
   * Returns { color: {r,g,b} | null, hex, confidence (0..1), edgePixels, opaqueEdgePixels,
   *           transparentRatio (0..1), band }.
   * `color` is null when every edge pixel is already transparent.
   */
  function detectBackgroundColor(img, options = {}) {
    const { width: w, height: h, data } = img;
    const band = options.band || defaultBand(w, h);
    const { opaque, total, transparent } = collectEdge(img, band);
    const result = {
      color: null,
      hex: null,
      confidence: 0,
      edgePixels: total,
      opaqueEdgePixels: opaque.length,
      transparentRatio: total ? transparent / total : 0,
      band,
    };
    if (!opaque.length) return result;

    const counts = new Uint32Array(32768);
    for (const i of opaque) counts[bucketOf(data, i)]++;

    let best = -1, bestScore = -1;
    for (let key = 0; key < 32768; key++) {
      if (!counts[key]) continue;
      const score = neighbourhood(counts, key);
      if (score > bestScore || (score === bestScore && counts[key] > counts[best])) {
        best = key;
        bestScore = score;
      }
    }

    const br = best >> 10, bg = (best >> 5) & 31, bb = best & 31;
    const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
    let n = 0;
    for (const i of opaque) {
      if (Math.abs((data[i] >> 3) - br) <= 1 && Math.abs((data[i + 1] >> 3) - bg) <= 1 && Math.abs((data[i + 2] >> 3) - bb) <= 1) {
        hr[data[i]]++;
        hg[data[i + 1]]++;
        hb[data[i + 2]]++;
        n++;
      }
    }

    const color = { r: median(hr, n), g: median(hg, n), b: median(hb, n) };
    result.color = color;
    result.hex = toHex(color);
    result.confidence = edgeMatchRatio(img, color, band);
    return result;
  }

  function channelAlpha(c, bg) {
    if (c > bg) return (c - bg) / (255 - bg);
    if (c < bg) return (bg - c) / bg;
    return 0;
  }

  function clampByte(v) {
    return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }

  /**
   * "Subtracts" the background color from one pixel: finds the smallest alpha for which the pixel
   * can be seen as (some color) blended over the background, and stores that color with that alpha.
   * A pixel equal to the background becomes fully transparent; a color far from it stays as is.
   * Returns true if the pixel changed.
   */
  function unblendPixel(data, i, cr, cg, cb) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a0 = data[i + 3];
    const a = Math.max(channelAlpha(r, cr), channelAlpha(g, cg), channelAlpha(b, cb));
    if (a >= 1) return false;
    if (a <= 1 / 255) {
      data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0;
      return true;
    }
    data[i] = clampByte(cr + (r - cr) / a);
    data[i + 1] = clampByte(cg + (g - cg) / a);
    data[i + 2] = clampByte(cb + (b - cb) / a);
    data[i + 3] = clampByte(a0 * a);
    return true;
  }

  /**
   * Step 2: remove the (confirmed) background color. Modifies img.data in place.
   *
   * options:
   *   tolerance   0..100 (default 10)   how far from `color` a pixel may be and still count as background
   *   mode        'connected' (default) only background reachable from the image's edges
   *               'global'              every matching pixel, holes inside objects included
   *   soften      true (default)        on the ring of pixels around the removed area, subtract the
   *                                     background color so anti-aliased edges lose their halo
   *   softenWidth 1 (default)           width of that ring, in pixels
   *
   * Returns { removed, softened } pixel counts.
   */
  function removeBackground(img, color, options = {}) {
    const { width: w, height: h, data } = img;
    const n = w * h;
    const tolerance = Math.max(0, Math.min(100, options.tolerance == null ? 10 : options.tolerance));
    const mode = options.mode === 'global' ? 'global' : 'connected';
    const soften = options.soften !== false;
    const softenWidth = options.softenWidth == null ? 1 : options.softenWidth;
    const { r: cr, g: cg, b: cb } = color;

    const matches = (p) => {
      const i = p * 4;
      return data[i + 3] < TRANSPARENT_ALPHA || colorDistance(data[i], data[i + 1], data[i + 2], cr, cg, cb) <= tolerance;
    };

    const mask = new Uint8Array(n); // 1 = background
    if (mode === 'global') {
      for (let p = 0; p < n; p++) if (matches(p)) mask[p] = 1;
    } else {
      const queue = new Int32Array(n);
      let head = 0, tail = 0;
      const visit = (p) => {
        if (!mask[p] && matches(p)) {
          mask[p] = 1;
          queue[tail++] = p;
        }
      };
      for (let x = 0; x < w; x++) {
        visit(x);
        visit((h - 1) * w + x);
      }
      for (let y = 0; y < h; y++) {
        visit(y * w);
        visit(y * w + w - 1);
      }
      while (head < tail) {
        const p = queue[head++];
        const x = p % w;
        if (x > 0) visit(p - 1);
        if (x < w - 1) visit(p + 1);
        if (p >= w) visit(p - w);
        if (p < n - w) visit(p + w);
      }
    }

    let removed = 0;
    for (let p = 0; p < n; p++) {
      if (!mask[p]) continue;
      const i = p * 4;
      if (data[i + 3] > 0) removed++;
      data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0;
    }

    let softened = 0;
    if (soften && softenWidth > 0 && removed > 0) {
      // level: 0 = untouched, 255 = background, k = k-th ring of pixels around the background
      const level = new Uint8Array(n);
      for (let p = 0; p < n; p++) if (mask[p]) level[p] = 255;
      const neighbours = (p, fn) => {
        const x = p % w, y = (p - x) / w;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if ((dx || dy) && xx >= 0 && xx < w) fn(yy * w + xx);
          }
        }
      };

      let ring = [];
      for (let p = 0; p < n; p++) {
        if (level[p]) continue;
        let touches = false;
        neighbours(p, (q) => { if (level[q] === 255) touches = true; });
        if (touches) ring.push(p);
      }
      for (const p of ring) level[p] = 1;

      for (let k = 1; ring.length; k++) {
        for (const p of ring) if (unblendPixel(data, p * 4, cr, cg, cb)) softened++;
        if (k >= softenWidth) break;
        const next = [];
        for (const p of ring) {
          neighbours(p, (q) => {
            if (!level[q]) {
              level[q] = k + 1;
              next.push(q);
            }
          });
        }
        ring = next;
      }
    }

    return { removed, softened };
  }

  return {
    TRANSPARENT_ALPHA,
    MATCH_DISTANCE,
    colorDistance,
    toHex,
    detectBackgroundColor,
    edgeMatchRatio,
    removeBackground,
  };
});
