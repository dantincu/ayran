/* Ayran Image Editor — a small MS Paint-like editor with transparency and two-step background removal. */
'use strict';
(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const doc = $('#doc');           // the image itself (the source of truth)
  const overlay = $('#overlay');   // previews: strokes in progress, shapes, floating selection
  const stage = $('#stage');
  const workspace = $('#workspace');
  const selectionBox = $('#selection-box');
  const dctx = doc.getContext('2d', { willReadFrequently: true });
  const octx = overlay.getContext('2d');

  const MAX_HISTORY = 40;
  const ZOOM_LEVELS = [0.1, 0.125, 0.25, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
  const PALETTE = [
    '#000000', '#464646', '#7f7f7f', '#880015', '#ed1c24', '#ff7f27', '#fff200', '#22b14c', '#00a2e8', '#3f48cc', '#a349a4',
    '#ffffff', '#c3c3c3', '#dcdcdc', '#b97a57', '#ffaec9', '#ffc90e', '#efe4b0', '#b5e61d', '#99d9ea', '#7092be', 'transparent',
  ];
  const TOOL_KEYS = { s: 'select', p: 'pencil', b: 'brush', e: 'eraser', g: 'fill', i: 'eyedropper', t: 'text', l: 'line', r: 'rect', o: 'ellipse' };

  const state = {
    tool: 'pencil',
    prevTool: 'pencil',
    size: 3,
    zoom: 1,
    shapeMode: 'outline',
    fillTolerance: 10,
    primary: { r: 0, g: 0, b: 0, a: 255 },
    secondary: { r: 255, g: 255, b: 255, a: 255 },
    activeSlot: 'primary',
    op: null,          // the pointer operation in progress
    selection: null,   // { x, y, w, h, floating: canvas | null }
    clipboard: null,   // canvas
    text: null,        // the text being typed
    history: [],
    future: [],
    fileName: 'untitled',
    picking: false,    // waiting for a click that picks the background color
    dirty: false,
  };

  // ---------------------------------------------------------------- helpers

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const hex2 = (v) => v.toString(16).padStart(2, '0');
  const rgbHex = (c) => '#' + hex2(c.r) + hex2(c.g) + hex2(c.b);
  const cssColor = (c) => `rgba(${c.r},${c.g},${c.b},${c.a / 255})`;
  function parseHex(hex) {
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function setStatus(msg) { $('#status-msg').textContent = msg || ''; }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  function cloneDoc() {
    const c = makeCanvas(doc.width, doc.height);
    c.getContext('2d').drawImage(doc, 0, 0);
    return c;
  }

  function pixelAt(x, y) {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return null;
    const d = dctx.getImageData(x, y, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] };
  }

  // ---------------------------------------------------------------- document size & zoom

  function setDocSize(w, h) {
    if (doc.width !== w || doc.height !== h) {
      doc.width = w;
      doc.height = h;
    }
    if (overlay.width !== w || overlay.height !== h) {
      overlay.width = w;
      overlay.height = h;
    }
    applyZoom();
  }

  function applyZoom() {
    stage.style.width = doc.width * state.zoom + 'px';
    stage.style.height = doc.height * state.zoom + 'px';
    $('#zoom-label').textContent = Math.round(state.zoom * 100) + '%';
    $('#status-size').textContent = `${doc.width} × ${doc.height}px`;
    updateSelectionBox();
    if (state.text) positionTextInput();
  }

  function setZoom(z, anchor) {
    const old = state.zoom;
    z = clamp(z, ZOOM_LEVELS[0], ZOOM_LEVELS[ZOOM_LEVELS.length - 1]);
    if (z === old) return;
    // keep the point under the cursor (or the center) in place
    const rect = workspace.getBoundingClientRect();
    const ax = anchor ? anchor.x - rect.left : rect.width / 2;
    const ay = anchor ? anchor.y - rect.top : rect.height / 2;
    const sr = stage.getBoundingClientRect();
    const docX = (rect.left + ax - sr.left) / old;
    const docY = (rect.top + ay - sr.top) / old;
    state.zoom = z;
    applyZoom();
    const nr = stage.getBoundingClientRect();
    workspace.scrollLeft += nr.left + docX * z - (rect.left + ax);
    workspace.scrollTop += nr.top + docY * z - (rect.top + ay);
  }

  function zoomStep(dir, anchor) {
    const z = state.zoom;
    const next = dir > 0 ? ZOOM_LEVELS.find((l) => l > z + 1e-6) : [...ZOOM_LEVELS].reverse().find((l) => l < z - 1e-6);
    if (next) setZoom(next, anchor);
  }

  function zoomToFit(maxZoom = 1) {
    const availW = workspace.clientWidth - 40;
    const availH = workspace.clientHeight - 40;
    state.zoom = clamp(Math.min(availW / doc.width, availH / doc.height, maxZoom), ZOOM_LEVELS[0], 32);
    applyZoom();
  }

  // ---------------------------------------------------------------- history

  function snapshot() { return dctx.getImageData(0, 0, doc.width, doc.height); }

  function restore(img) {
    setDocSize(img.width, img.height);
    dctx.putImageData(img, 0, 0);
  }

  function pushHistory() {
    state.history.push(snapshot());
    if (state.history.length > MAX_HISTORY) state.history.shift();
    state.future.length = 0;
    state.dirty = true;
    updateButtons();
  }

  function undo() {
    if (state.op) return;
    cancelText();
    dropSelection();
    if (!state.history.length) return;
    state.future.push(snapshot());
    restore(state.history.pop());
    updateButtons();
  }

  function redo() {
    if (state.op) return;
    cancelText();
    dropSelection();
    if (!state.future.length) return;
    state.history.push(snapshot());
    restore(state.future.pop());
    updateButtons();
  }

  function updateButtons() {
    $('#btn-undo').disabled = !state.history.length;
    $('#btn-redo').disabled = !state.future.length;
    $('#btn-crop').disabled = !state.selection;
  }

  // ---------------------------------------------------------------- painting helpers

  function clearOverlay() {
    octx.clearRect(0, 0, overlay.width, overlay.height);
    overlay.style.opacity = 1;
  }

  /** Strokes are drawn opaque on the overlay and composited with the color's alpha on release, so overlaps don't darken. */
  function prepareStroke(color) {
    clearOverlay();
    const style = color.a === 0 ? '#808080' : rgbHex(color);
    octx.fillStyle = style;
    octx.strokeStyle = style;
    overlay.style.opacity = color.a === 0 ? 0.5 : color.a / 255;
  }

  function commitOverlay(color) {
    dctx.save();
    if (color.a === 0) dctx.globalCompositeOperation = 'destination-out'; // painting with "transparent" erases
    else dctx.globalAlpha = color.a / 255;
    dctx.drawImage(overlay, 0, 0);
    dctx.restore();
    clearOverlay();
  }

  /** Hard-edged square stamps along a Bresenham line (pencil, eraser). */
  function stampLine(ctx, a, b, size) {
    let x0 = Math.floor(a.x), y0 = Math.floor(a.y);
    const x1 = Math.floor(b.x), y1 = Math.floor(b.y);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    const off = Math.floor(size / 2);
    let err = dx + dy;
    for (;;) {
      ctx.fillRect(x0 - off, y0 - off, size, size);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  function brushSegment(ctx, a, b, size) {
    ctx.lineWidth = size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (a.x === b.x && a.y === b.y) {
      ctx.beginPath();
      ctx.arc(a.x, a.y, size / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  /** Fills or strokes the current path with a color; a fully transparent color erases (or previews as gray). */
  function paint(ctx, kind, color, preview) {
    ctx.save();
    let style = cssColor(color);
    if (color.a === 0) {
      if (preview) { ctx.globalAlpha = 0.5; style = '#808080'; }
      else { ctx.globalCompositeOperation = 'destination-out'; style = '#000'; }
    }
    if (kind === 'fill') { ctx.fillStyle = style; ctx.fill(); }
    else { ctx.strokeStyle = style; ctx.stroke(); }
    ctx.restore();
  }

  function shapeGeometry(tool, a, b, shift) {
    const snap = (v) => Math.floor(v) + (state.size % 2 ? 0.5 : 0);
    let x0 = snap(a.x), y0 = snap(a.y), x1 = snap(b.x), y1 = snap(b.y);
    if (tool === 'line') {
      if (shift) {
        const step = Math.PI / 4;
        const ang = Math.round(Math.atan2(y1 - y0, x1 - x0) / step) * step;
        const len = Math.hypot(x1 - x0, y1 - y0);
        x1 = x0 + Math.round(Math.cos(ang) * len);
        y1 = y0 + Math.round(Math.sin(ang) * len);
      }
      return { x0, y0, x1, y1 };
    }
    if (shift) {
      const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      x1 = x0 + (x1 < x0 ? -s : s);
      y1 = y0 + (y1 < y0 ? -s : s);
    }
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  }

  function drawShape(ctx, tool, op, end, preview) {
    const g = shapeGeometry(tool, op.start, end, op.shift);
    ctx.save();
    ctx.lineWidth = state.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = tool === 'rect' ? 'miter' : 'round';
    ctx.beginPath();
    if (tool === 'line') {
      ctx.moveTo(g.x0, g.y0);
      ctx.lineTo(g.x1, g.y1);
      paint(ctx, 'stroke', op.color, preview);
    } else {
      if (tool === 'rect') ctx.rect(g.x, g.y, g.w, g.h);
      else ctx.ellipse(g.x + g.w / 2, g.y + g.h / 2, g.w / 2, g.h / 2, 0, 0, Math.PI * 2);
      if (state.shapeMode === 'filled') paint(ctx, 'fill', op.color, preview);
      else {
        if (state.shapeMode === 'both') paint(ctx, 'fill', op.other, preview);
        paint(ctx, 'stroke', op.color, preview);
      }
    }
    ctx.restore();
  }

  /** Flood fill that replaces pixels with the exact RGBA of the color (so filling with a transparent color works). */
  function floodFill(px, py, color) {
    const w = doc.width, h = doc.height;
    const x0 = Math.floor(px), y0 = Math.floor(py);
    if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return false;
    const img = snapshot();
    const d = img.data;
    const start = (y0 * w + x0) * 4;
    const tr = d[start], tg = d[start + 1], tb = d[start + 2], ta = d[start + 3];
    const fill = [color.r, color.g, color.b, color.a];
    if (state.fillTolerance === 0 && tr === fill[0] && tg === fill[1] && tb === fill[2] && ta === fill[3]) return false;
    const tol = state.fillTolerance * 2.55;
    const matches = (i) => {
      const a = d[i + 3];
      if (ta === 0 && a === 0) return true; // all fully transparent pixels are alike
      return Math.abs(d[i] - tr) <= tol && Math.abs(d[i + 1] - tg) <= tol && Math.abs(d[i + 2] - tb) <= tol && Math.abs(a - ta) <= tol;
    };
    const seen = new Uint8Array(w * h);
    const stack = [y0 * w + x0];
    seen[y0 * w + x0] = 1;
    while (stack.length) {
      const p = stack.pop();
      const i = p * 4;
      d[i] = fill[0]; d[i + 1] = fill[1]; d[i + 2] = fill[2]; d[i + 3] = fill[3];
      const x = p % w;
      const push = (q) => {
        if (!seen[q] && matches(q * 4)) { seen[q] = 1; stack.push(q); }
      };
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (p >= w) push(p - w);
      if (p < w * h - w) push(p + w);
    }
    pushHistory();
    dctx.putImageData(img, 0, 0);
    return true;
  }

  // ---------------------------------------------------------------- selection

  function updateSelectionBox() {
    const s = state.selection;
    if (!s) { selectionBox.hidden = true; return; }
    const z = state.zoom;
    Object.assign(selectionBox.style, { left: s.x * z + 'px', top: s.y * z + 'px', width: s.w * z + 'px', height: s.h * z + 'px' });
    selectionBox.hidden = false;
  }

  function renderSelection() {
    clearOverlay();
    const s = state.selection;
    if (s && s.floating) octx.drawImage(s.floating, s.x, s.y);
    updateSelectionBox();
    updateButtons();
  }

  /** Cuts the selected pixels out of the image into a floating canvas that can be moved. */
  function liftSelection() {
    const s = state.selection;
    pushHistory();
    const c = makeCanvas(s.w, s.h);
    c.getContext('2d').drawImage(doc, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h);
    dctx.clearRect(s.x, s.y, s.w, s.h);
    s.floating = c;
  }

  /** Stamps a floating selection back onto the image and deselects. */
  function commitSelection() {
    const s = state.selection;
    if (!s) return;
    if (s.floating) dctx.drawImage(s.floating, s.x, s.y);
    state.selection = null;
    renderSelection();
  }

  /** Deselects; a floating selection is discarded. */
  function dropSelection() {
    if (!state.selection) return;
    state.selection = null;
    renderSelection();
  }

  function selectionCanvas() {
    const s = state.selection;
    if (s.floating) return s.floating;
    const c = makeCanvas(s.w, s.h);
    c.getContext('2d').drawImage(doc, s.x, s.y, s.w, s.h, 0, 0, s.w, s.h);
    return c;
  }

  function copySelection() {
    if (!state.selection) return false;
    const c = selectionCanvas();
    const copy = makeCanvas(c.width, c.height);
    copy.getContext('2d').drawImage(c, 0, 0);
    state.clipboard = copy;
    // also offer it to other apps; ignored where the browser doesn't allow it
    if (navigator.clipboard && window.ClipboardItem) {
      copy.toBlob((blob) => {
        if (blob) navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).catch(() => {});
      });
    }
    setStatus(`Copied ${c.width} × ${c.height}px`);
    return true;
  }

  function deleteSelection() {
    const s = state.selection;
    if (!s) return;
    if (!s.floating) {
      pushHistory();
      dctx.clearRect(s.x, s.y, s.w, s.h);
    }
    state.selection = null;
    renderSelection();
  }

  function pasteImage(src) {
    cancelText();
    commitSelection();
    pushHistory();
    const w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
    if (w > doc.width || h > doc.height) {
      const keep = snapshot();
      setDocSize(Math.max(w, doc.width), Math.max(h, doc.height));
      dctx.clearRect(0, 0, doc.width, doc.height);
      dctx.putImageData(keep, 0, 0);
    }
    const c = makeCanvas(w, h);
    c.getContext('2d').drawImage(src, 0, 0);
    setTool('select');
    state.selection = { x: 0, y: 0, w, h, floating: c };
    renderSelection();
    setStatus('Pasted — drag it into place, Enter or click outside to finish, Del to discard');
  }

  function selectAll() {
    cancelText();
    commitSelection();
    setTool('select');
    state.selection = { x: 0, y: 0, w: doc.width, h: doc.height, floating: null };
    renderSelection();
  }

  function cropToSelection() {
    const s = state.selection;
    if (!s) return;
    const rect = { x: s.x, y: s.y, w: s.w, h: s.h };
    commitSelection();
    const x0 = clamp(rect.x, 0, doc.width), y0 = clamp(rect.y, 0, doc.height);
    const x1 = clamp(rect.x + rect.w, 0, doc.width), y1 = clamp(rect.y + rect.h, 0, doc.height);
    if (x1 <= x0 || y1 <= y0) return;
    pushHistory();
    const img = dctx.getImageData(x0, y0, x1 - x0, y1 - y0);
    setDocSize(x1 - x0, y1 - y0);
    dctx.putImageData(img, 0, 0);
    setStatus(`Cropped to ${x1 - x0} × ${y1 - y0}px`);
  }

  const inSelection = (p) => {
    const s = state.selection;
    return s && p.x >= s.x && p.y >= s.y && p.x < s.x + s.w && p.y < s.y + s.h;
  };

  // ---------------------------------------------------------------- text

  function textFontSize() { return Math.max(8, state.size * 4); }

  function openTextInput(p, color) {
    commitText();
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'text-input';
    input.spellcheck = false;
    state.text = { input, x: Math.floor(p.x), y: Math.floor(p.y), color, fontSize: textFontSize() };
    positionTextInput();
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitText(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelText(); }
    });
    input.addEventListener('input', () => { input.size = Math.max(4, input.value.length + 1); });
    input.addEventListener('blur', () => commitText());
    stage.appendChild(input);
    setTimeout(() => input.focus(), 0);
  }

  function positionTextInput() {
    const t = state.text;
    const z = state.zoom;
    Object.assign(t.input.style, {
      left: t.x * z + 'px',
      top: t.y * z + 'px',
      fontSize: t.fontSize * z + 'px',
      color: t.color.a === 0 ? '#808080' : rgbHex(t.color),
    });
  }

  function commitText() {
    const t = state.text;
    if (!t) return;
    state.text = null;
    const value = t.input.value;
    t.input.remove();
    if (!value) return;
    pushHistory();
    dctx.save();
    dctx.font = `${t.fontSize}px sans-serif`;
    dctx.textBaseline = 'top';
    if (t.color.a === 0) { dctx.globalCompositeOperation = 'destination-out'; dctx.fillStyle = '#000'; }
    else dctx.fillStyle = cssColor(t.color);
    dctx.fillText(value, t.x + 1, t.y + 1);
    dctx.restore();
  }

  function cancelText() {
    const t = state.text;
    if (!t) return;
    state.text = null;
    t.input.remove();
  }

  // ---------------------------------------------------------------- tools

  const TOOLS = {
    pencil: {
      down(op, p) { pushHistory(); prepareStroke(op.color); stampLine(octx, p, p, state.size); },
      move(op, p) { stampLine(octx, op.last, p, state.size); },
      up(op) { commitOverlay(op.color); },
    },
    brush: {
      down(op, p) { pushHistory(); prepareStroke(op.color); brushSegment(octx, p, p, state.size); },
      move(op, p) { brushSegment(octx, op.last, p, state.size); },
      up(op) { commitOverlay(op.color); },
    },
    eraser: {
      down(op, p) {
        pushHistory();
        dctx.save();
        dctx.globalCompositeOperation = 'destination-out';
        dctx.fillStyle = '#000';
        stampLine(dctx, p, p, state.size);
      },
      move(op, p) { stampLine(dctx, op.last, p, state.size); },
      up() { dctx.restore(); },
    },
    line: shapeTool('line'),
    rect: shapeTool('rect'),
    ellipse: shapeTool('ellipse'),
    fill: {
      down(op, p) { floodFill(p.x, p.y, op.color); return false; },
    },
    eyedropper: {
      down(op, p) {
        const c = pixelAt(p.x, p.y);
        if (c) {
          state[op.button === 2 ? 'secondary' : 'primary'] = c;
          updateColorUI();
          setStatus(`Picked ${rgbHex(c).toUpperCase()}${c.a < 255 ? ` at ${Math.round((c.a / 255) * 100)}% opacity` : ''}`);
        }
        setTool(state.prevTool);
        return false;
      },
    },
    text: {
      down(op, p) { openTextInput(p, op.color); return false; },
    },
    select: {
      down(op, p) {
        if (inSelection(p)) {
          if (!state.selection.floating) liftSelection();
          op.mode = 'move';
          op.origin = { x: state.selection.x, y: state.selection.y };
          return;
        }
        commitSelection();
        op.mode = 'new';
      },
      move(op, p) {
        if (op.mode === 'move') {
          state.selection.x = op.origin.x + Math.round(p.x - op.start.x);
          state.selection.y = op.origin.y + Math.round(p.y - op.start.y);
        } else {
          const x0 = clamp(Math.floor(Math.min(op.start.x, p.x)), 0, doc.width);
          const y0 = clamp(Math.floor(Math.min(op.start.y, p.y)), 0, doc.height);
          const x1 = clamp(Math.ceil(Math.max(op.start.x, p.x)), 0, doc.width);
          const y1 = clamp(Math.ceil(Math.max(op.start.y, p.y)), 0, doc.height);
          state.selection = x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0, floating: null } : null;
        }
        renderSelection();
      },
      up(op) {
        if (op.mode === 'new' && state.selection) setStatus(`Selected ${state.selection.w} × ${state.selection.h}px`);
      },
    },
  };

  function shapeTool(kind) {
    return {
      down(op) { clearOverlay(); op.moved = false; },
      move(op, p) {
        op.moved = true;
        op.end = p;
        clearOverlay();
        drawShape(octx, kind, op, p, true);
      },
      up(op) {
        clearOverlay();
        if (!op.moved) return;
        pushHistory();
        drawShape(dctx, kind, op, op.end, false);
      },
    };
  }

  function setTool(tool) {
    if (!TOOLS[tool]) return;
    if (state.op) return;
    commitText();
    if (tool !== 'select') commitSelection();
    if (tool !== state.tool && state.tool !== 'eyedropper') state.prevTool = state.tool;
    state.tool = tool;
    $$('.tools button').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    $$('.tool-options [data-tools]').forEach((el) => { el.hidden = !el.dataset.tools.split(' ').includes(tool); });
    $('#size-caption').textContent = tool === 'text' ? 'Text size' : 'Size';
    overlay.className = 'tool-' + tool;
  }

  // ---------------------------------------------------------------- pointer input

  function toDoc(e) {
    const r = overlay.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * doc.width) / r.width, y: ((e.clientY - r.top) * doc.height) / r.height };
  }

  overlay.addEventListener('contextmenu', (e) => e.preventDefault());

  overlay.addEventListener('pointerdown', (e) => {
    if ((e.button !== 0 && e.button !== 2) || state.op) return;
    e.preventDefault();
    const p = toDoc(e);
    if (state.picking) { finishBackgroundPick(p); return; }
    if (state.text) { commitText(); if (state.tool === 'text') return; }
    const right = e.button === 2;
    const op = {
      button: e.button,
      pointerId: e.pointerId,
      color: right ? state.secondary : state.primary,
      other: right ? state.primary : state.secondary,
      start: p,
      last: p,
      shift: e.shiftKey,
    };
    const tool = TOOLS[state.tool];
    if (tool.down(op, p, e) === false) return;
    state.op = op;
    overlay.setPointerCapture(e.pointerId);
  });

  overlay.addEventListener('pointermove', (e) => {
    const p = toDoc(e);
    const inside = p.x >= 0 && p.y >= 0 && p.x < doc.width && p.y < doc.height;
    $('#status-pos').textContent = inside ? `${Math.floor(p.x)}, ${Math.floor(p.y)}px` : '';
    if (!state.op && state.tool === 'select') overlay.style.cursor = inSelection(p) ? 'move' : '';
    const op = state.op;
    if (!op || e.pointerId !== op.pointerId) return;
    op.shift = e.shiftKey;
    const tool = TOOLS[state.tool];
    // use coalesced events for smooth freehand strokes
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [e]) {
      const q = toDoc(ev);
      tool.move && tool.move(op, q, ev);
      op.last = q;
    }
  });

  function endPointer(e) {
    const op = state.op;
    if (!op || e.pointerId !== op.pointerId) return;
    state.op = null;
    const tool = TOOLS[state.tool];
    tool.up && tool.up(op, toDoc(e), e);
    if (overlay.hasPointerCapture(e.pointerId)) overlay.releasePointerCapture(e.pointerId);
  }
  overlay.addEventListener('pointerup', endPointer);
  overlay.addEventListener('pointercancel', endPointer);
  overlay.addEventListener('pointerleave', () => { $('#status-pos').textContent = ''; });

  workspace.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomStep(e.deltaY < 0 ? 1 : -1, { x: e.clientX, y: e.clientY });
  }, { passive: false });

  // ---------------------------------------------------------------- files

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('This file could not be read as an image.'));
      img.src = src;
    });
  }

  async function openFile(file) {
    if (!file || !file.type.startsWith('image/')) { setStatus('That is not an image file.'); return; }
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      cancelText();
      dropSelection();
      pushHistory();
      setDocSize(img.naturalWidth, img.naturalHeight);
      dctx.clearRect(0, 0, doc.width, doc.height);
      dctx.drawImage(img, 0, 0);
      state.fileName = file.name.replace(/\.[^.]+$/, '') || 'untitled';
      state.dirty = false;
      zoomToFit();
      document.title = `${file.name} — Ayran Image Editor`;
      setStatus(`Opened ${file.name}`);
    } catch (err) {
      setStatus(err.message);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function save() {
    cancelText();
    commitSelection();
    doc.toBlob((blob) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = state.fileName + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      state.dirty = false;
      setStatus(`Saved ${a.download}`);
    }, 'image/png');
  }

  $('#file-input').addEventListener('change', (e) => {
    openFile(e.target.files[0]);
    e.target.value = '';
  });

  workspace.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    workspace.classList.add('dragging');
  });
  workspace.addEventListener('dragleave', () => workspace.classList.remove('dragging'));
  workspace.addEventListener('drop', (e) => {
    e.preventDefault();
    workspace.classList.remove('dragging');
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
    if (file) openFile(file);
  });

  document.addEventListener('paste', async (e) => {
    if (e.target.closest && e.target.closest('input, textarea, dialog')) return;
    const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith('image/'));
    if (item) {
      e.preventDefault();
      const url = URL.createObjectURL(item.getAsFile());
      try { pasteImage(await loadImage(url)); } catch (err) { setStatus(err.message); } finally { URL.revokeObjectURL(url); }
    } else if (state.clipboard) {
      e.preventDefault();
      pasteImage(state.clipboard);
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ---------------------------------------------------------------- image commands

  function transformImage(kind) {
    cancelText();
    commitSelection();
    pushHistory();
    const src = cloneDoc();
    const w = src.width, h = src.height;
    if (kind === 'rotCW') setDocSize(h, w);
    dctx.save();
    dctx.clearRect(0, 0, doc.width, doc.height);
    if (kind === 'flipH') { dctx.translate(w, 0); dctx.scale(-1, 1); }
    else if (kind === 'flipV') { dctx.translate(0, h); dctx.scale(1, -1); }
    else if (kind === 'rotCW') { dctx.translate(h, 0); dctx.rotate(Math.PI / 2); }
    dctx.drawImage(src, 0, 0);
    dctx.restore();
  }

  function newImage() {
    const dlg = $('#new-dialog');
    dlg.returnValue = '';
    dlg.showModal();
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return;
      const w = clamp(parseInt($('#new-width').value, 10) || 800, 1, 10000);
      const h = clamp(parseInt($('#new-height').value, 10) || 600, 1, 10000);
      cancelText();
      dropSelection();
      pushHistory();
      setDocSize(w, h);
      dctx.clearRect(0, 0, w, h);
      const bg = $('#new-bg').value;
      if (bg !== 'transparent') {
        dctx.fillStyle = bg === 'white' ? '#fff' : cssColor(state.secondary);
        dctx.fillRect(0, 0, w, h);
      }
      state.fileName = 'untitled';
      state.dirty = false;
      document.title = 'Ayran Image Editor';
      zoomToFit();
      setStatus(`New ${w} × ${h}px image`);
    };
  }

  function resizeImage() {
    const dlg = $('#resize-dialog');
    const wIn = $('#resize-width'), hIn = $('#resize-height'), keep = $('#resize-keep-ratio');
    const ratio = doc.width / doc.height;
    wIn.value = doc.width;
    hIn.value = doc.height;
    wIn.oninput = () => { if (keep.checked) hIn.value = Math.max(1, Math.round(wIn.value / ratio)); };
    hIn.oninput = () => { if (keep.checked) wIn.value = Math.max(1, Math.round(hIn.value * ratio)); };
    dlg.returnValue = '';
    dlg.showModal();
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return;
      const w = clamp(parseInt(wIn.value, 10) || doc.width, 1, 10000);
      const h = clamp(parseInt(hIn.value, 10) || doc.height, 1, 10000);
      const scale = document.querySelector('input[name="resize-mode"]:checked').value === 'scale';
      cancelText();
      commitSelection();
      pushHistory();
      const src = cloneDoc();
      setDocSize(w, h);
      dctx.clearRect(0, 0, w, h);
      dctx.save();
      dctx.imageSmoothingQuality = 'high';
      if (scale) dctx.drawImage(src, 0, 0, w, h);
      else dctx.drawImage(src, 0, 0);
      dctx.restore();
      setStatus(`Resized to ${w} × ${h}px`);
    };
  }

  // ---------------------------------------------------------------- remove background (two steps)

  const bg = { color: null };

  /** Step 1: detect the background color and show it to the user. */
  function startRemoveBackground() {
    cancelText();
    commitSelection();
    const result = BgRemoval.detectBackgroundColor(snapshot());
    showBackgroundDialog(result.color, 'detected', result);
  }

  function showBackgroundDialog(color, source, result) {
    bg.color = color;
    const pct = (v) => Math.round(v * 100) + '%';
    const warning = $('#bg-warning');
    warning.hidden = true;

    if (color) {
      $('#bg-sample-color').style.background = rgbHex(color);
      $('#bg-hex').textContent = BgRemoval.toHex(color);
      $('#bg-rgb').textContent = `rgb(${color.r}, ${color.g}, ${color.b})`;
      $('#bg-source').textContent = source === 'detected' ? "Detected from the image's edges" : 'Picked by you';
      $('#bg-confidence').textContent = `Matches ${pct(result.confidence)} of the opaque pixels along the edges`;
      if (source === 'detected' && result.transparentRatio > 0.5) {
        warning.textContent = `The edges are already mostly transparent (${pct(result.transparentRatio)}); this is the most common remaining color there.`;
        warning.hidden = false;
      } else if (source === 'detected' && result.confidence < 0.5) {
        warning.textContent = "The edges have no clearly dominant color, so this may not be the background — check it, or pick it yourself.";
        warning.hidden = false;
      }
    } else {
      $('#bg-sample-color').style.background = 'transparent';
      $('#bg-hex').textContent = 'none';
      $('#bg-rgb').textContent = '';
      $('#bg-source').textContent = '';
      $('#bg-confidence').textContent = '';
      warning.textContent = "All the pixels along the edges are already transparent — there is no background color to remove. You can still pick a color in the image.";
      warning.hidden = false;
    }
    $('#bg-question').hidden = !color;
    $('#bg-confirm').disabled = !color;
    const dlg = $('#bg-dialog');
    if (!dlg.open) dlg.showModal();
    if (color) $('#bg-confirm').focus();
  }

  /** Step 2: the user confirmed the color — subtract it from the image's background. */
  function confirmRemoveBackground() {
    if (!bg.color) return;
    $('#bg-dialog').close();
    const options = {
      tolerance: parseInt($('#bg-tolerance').value, 10),
      mode: document.querySelector('input[name="bg-mode"]:checked').value,
      soften: $('#bg-soften').checked,
    };
    const img = snapshot();
    const { removed, softened } = BgRemoval.removeBackground(img, bg.color, options);
    const hex = BgRemoval.toHex(bg.color);
    if (!removed && !softened) {
      setStatus(`No pixels of ${hex} were found${options.mode === 'connected' ? " touching the image's edges" : ''} — nothing removed.`);
      return;
    }
    pushHistory();
    dctx.putImageData(img, 0, 0);
    setStatus(`Removed background ${hex}: ${removed.toLocaleString()} pixels made transparent` +
      (softened ? `, ${softened.toLocaleString()} edge pixels softened` : '') + ' (Ctrl+Z to undo)');
  }

  function startBackgroundPick() {
    $('#bg-dialog').close();
    state.picking = true;
    overlay.classList.add('picking');
    setStatus('Click on the background in the image to pick its color (Esc to cancel)');
  }

  function stopBackgroundPick() {
    state.picking = false;
    overlay.classList.remove('picking');
  }

  function finishBackgroundPick(p) {
    const c = pixelAt(p.x, p.y);
    if (!c) return;
    if (c.a < BgRemoval.TRANSPARENT_ALPHA) { setStatus('That pixel is already transparent — click on the background color'); return; }
    stopBackgroundPick();
    setStatus('');
    const color = { r: c.r, g: c.g, b: c.b };
    const confidence = BgRemoval.edgeMatchRatio(snapshot(), color);
    showBackgroundDialog(color, 'picked', { confidence, transparentRatio: 0 });
  }

  $('#bg-confirm').addEventListener('click', confirmRemoveBackground);
  $('#bg-cancel').addEventListener('click', () => $('#bg-dialog').close());
  $('#bg-pick').addEventListener('click', startBackgroundPick);
  $('#bg-tolerance').addEventListener('input', (e) => { $('#bg-tolerance-value').textContent = e.target.value; });

  // ---------------------------------------------------------------- colors

  function updateColorUI() {
    $('#slot-primary span').style.background = cssColor(state.primary);
    $('#slot-secondary span').style.background = cssColor(state.secondary);
    $('#slot-primary').classList.toggle('active', state.activeSlot === 'primary');
    $('#slot-secondary').classList.toggle('active', state.activeSlot === 'secondary');
    const c = state[state.activeSlot];
    $('#active-slot-label').textContent = state.activeSlot === 'primary' ? 'Color 1' : 'Color 2';
    $('#color-input').value = rgbHex(c);
    $('#color-hex').textContent = rgbHex(c).toUpperCase();
    $('#alpha-input').value = c.a;
    $('#alpha-value').textContent = Math.round((c.a / 255) * 100) + '%';
  }

  function buildPalette() {
    const pal = $('#palette');
    for (const hex of PALETTE) {
      const b = document.createElement('button');
      if (hex === 'transparent') {
        b.className = 'checker transparent-swatch';
        b.title = 'Transparent — paints transparency';
      } else {
        b.style.background = hex;
        b.title = hex.toUpperCase();
      }
      const color = hex === 'transparent' ? { r: 255, g: 255, b: 255, a: 0 } : { ...parseHex(hex), a: 255 };
      const pick = (slot) => { state[slot] = { ...color }; updateColorUI(); };
      b.addEventListener('click', () => pick('primary'));
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); pick('secondary'); });
      pal.appendChild(b);
    }
  }

  $('#slot-primary').addEventListener('click', () => { state.activeSlot = 'primary'; updateColorUI(); });
  $('#slot-secondary').addEventListener('click', () => { state.activeSlot = 'secondary'; updateColorUI(); });
  $('#color-input').addEventListener('input', (e) => {
    const c = state[state.activeSlot];
    Object.assign(c, parseHex(e.target.value));
    if (c.a === 0) c.a = 255; // choosing a color implies wanting to see it
    updateColorUI();
  });
  $('#alpha-input').addEventListener('input', (e) => {
    state[state.activeSlot].a = parseInt(e.target.value, 10);
    updateColorUI();
  });

  function swapColors() {
    [state.primary, state.secondary] = [state.secondary, state.primary];
    updateColorUI();
  }

  // ---------------------------------------------------------------- toolbar wiring

  $$('.tools button').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

  $('#size').addEventListener('input', (e) => {
    state.size = parseInt(e.target.value, 10);
    $('#size-value').textContent = state.size;
  });
  $('#fill-tolerance').addEventListener('input', (e) => {
    state.fillTolerance = parseInt(e.target.value, 10);
    $('#fill-tolerance-value').textContent = state.fillTolerance;
  });
  $$('input[name="shape-mode"]').forEach((r) => r.addEventListener('change', () => { state.shapeMode = r.value; }));

  const ACTIONS = {
    new: newImage,
    open: () => $('#file-input').click(),
    save,
    undo,
    redo,
    resize: resizeImage,
    crop: cropToSelection,
    flipH: () => transformImage('flipH'),
    flipV: () => transformImage('flipV'),
    rotCW: () => transformImage('rotCW'),
    removeBg: startRemoveBackground,
    zoomIn: () => zoomStep(1),
    zoomOut: () => zoomStep(-1),
    zoomFit: () => zoomToFit(32),
    zoom100: () => setZoom(1),
    swap: swapColors,
  };
  $$('[data-action]').forEach((b) => b.addEventListener('click', () => ACTIONS[b.dataset.action]()));

  // ---------------------------------------------------------------- keyboard

  document.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'radio' && t.type !== 'checkbox' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;

    if (mod) {
      const map = {
        z: e.shiftKey ? redo : undo, y: redo, s: save, o: ACTIONS.open, n: newImage, a: selectAll,
        c: copySelection, x: () => { if (copySelection()) deleteSelection(); },
        '=': ACTIONS.zoomIn, '+': ACTIONS.zoomIn, '-': ACTIONS.zoomOut, '0': ACTIONS.zoomFit, '1': ACTIONS.zoom100,
      };
      if (map[key]) { e.preventDefault(); map[key](); }
      return; // Ctrl+V is handled by the paste event
    }

    if (e.key === 'Escape') {
      if (state.picking) { stopBackgroundPick(); setStatus('Background pick cancelled'); }
      else if (state.selection) commitSelection();
      return;
    }
    if (e.key === 'Enter' && state.selection) { commitSelection(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection) { e.preventDefault(); deleteSelection(); return; }
    if (state.selection && state.selection.floating && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') state.selection.x -= step;
      if (e.key === 'ArrowRight') state.selection.x += step;
      if (e.key === 'ArrowUp') state.selection.y -= step;
      if (e.key === 'ArrowDown') state.selection.y += step;
      renderSelection();
      return;
    }
    if (key === 'x') { swapColors(); return; }
    if (TOOL_KEYS[key]) setTool(TOOL_KEYS[key]);
  });

  // ---------------------------------------------------------------- start

  function init() {
    buildPalette();
    setDocSize(800, 600);
    dctx.fillStyle = '#fff';
    dctx.fillRect(0, 0, 800, 600);
    setTool('pencil');
    updateColorUI();
    updateButtons();
    zoomToFit();
    setStatus('Draw, or open / drop / paste an image. Left button paints with color 1, right button with color 2.');
  }

  init();
})();
