import {
  ENTRIES_KEY,
  SETTINGS_KEY,
  getEntries,
  getSettings,
  saveSettings,
  normalizeSettings,
  mutateEntries,
  refreshEntryFavicon,
  chromeFaviconUrl,
  isViewUrl,
  newEntry,
} from '../shared/store.js';
import { displayUrl, hostOf, secondLevelDomain, matchLevel, MATCH_LEVELS } from '../shared/urls.js';
import {
  moveSelectedBy,
  moveSelectedToStart,
  moveSelectedToEnd,
  moveSelectedBefore,
  applyOrder,
} from '../shared/reorder.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  entries: [],
  settings: normalizeSettings(),
  selectMode: false,
  selected: new Set(),
  anchorId: null, // last checkbox clicked, for Shift+click ranges
  drag: null,
  renderDeferred: false,
  myTabId: null,
};

const MATCH_LABELS = {
  exact: 'Exact match',
  equal: 'Equal',
  domain: 'Partial (same domain)',
  sld: 'Partial (same 2nd level domain)',
};

const ICONS = {
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

// ---- startup -----------------------------------------------------------------------------

init();

async function init() {
  const [entries, settings, me] = await Promise.all([getEntries(), getSettings(), chrome.tabs.getCurrent()]);
  state.entries = entries;
  state.myTabId = me?.id ?? null;
  applySettings(settings);
  wireTopbar();
  wireGrid();
  wireMatchView();
  wireSettings();
  wireKeyboard();
  showShortcut();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[SETTINGS_KEY]) applySettings(normalizeSettings(changes[SETTINGS_KEY].newValue));
    if (changes[ENTRIES_KEY]) {
      state.entries = changes[ENTRIES_KEY].newValue || [];
      const ids = new Set(state.entries.map((e) => e.id));
      for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
      render();
    }
  });

  const onTabsChanged = debounce(() => {
    if (route().view === 'match') renderMatch();
  }, 150);
  chrome.tabs.onUpdated.addListener(onTabsChanged);
  chrome.tabs.onCreated.addListener(onTabsChanged);
  chrome.tabs.onRemoved.addListener(onTabsChanged);
  chrome.tabs.onReplaced.addListener(onTabsChanged);

  addEventListener('hashchange', () => {
    hideMenu();
    render();
  });
  render();
}

function applySettings(settings) {
  state.settings = settings;
  document.documentElement.style.setProperty('--tab-width', `${settings.tabWidth}px`);
  const showUrl = $('#set-show-url');
  const width = $('#set-width');
  if (showUrl) showUrl.checked = settings.showUrl;
  if (width && document.activeElement !== width) width.value = settings.tabWidth;
  render();
}

async function showShortcut() {
  try {
    const cmd = (await chrome.commands.getAll()).find((c) => c.name === 'open-view');
    $('#shortcut-hint').textContent = cmd?.shortcut || 'a keyboard shortcut (set one at chrome://extensions/shortcuts)';
  } catch {
    /* keep the default text */
  }
}

// ---- routing -----------------------------------------------------------------------------

function route() {
  const m = /^#match\/(.+)$/.exec(location.hash);
  return m ? { view: 'match', entryId: decodeURIComponent(m[1]) } : { view: 'list' };
}

function goToList() {
  if (route().view === 'list') return;
  // Use history when we came from the list, so the browser's Back works naturally.
  if (history.length > 1 && history.state?.fromList) history.back();
  else location.hash = '';
}

function render() {
  if (state.drag?.started) {
    state.renderDeferred = true;
    return;
  }
  const r = route();
  const inMatch = r.view === 'match';
  $('#list-view').hidden = inMatch;
  $('#match-view').hidden = !inMatch;
  $('#back').hidden = !inMatch;
  $('#select-toggle').hidden = inMatch;
  $('#remember-all').hidden = inMatch || state.selectMode;
  $('#select-tools').hidden = inMatch || !state.selectMode;
  document.body.classList.toggle('select-mode', state.selectMode && !inMatch);
  $('#count').textContent = state.entries.length ? `(${state.entries.length})` : '';
  document.title = `Fav Tabs${state.entries.length ? ` (${state.entries.length})` : ''}`;
  if (inMatch) renderMatch();
  else renderList();
}

// ---- list view ------------------------------------------------------------------------------

function renderList() {
  const grid = $('#grid');
  grid.replaceChildren(...state.entries.map((e) => makeHead(e, { selectable: state.selectMode })));
  $('#empty').hidden = state.entries.length > 0;
  $('#select-toggle').classList.toggle('active', state.selectMode);
  const n = state.selected.size;
  $('#sel-count').textContent = `${n} selected`;
  for (const b of document.querySelectorAll('[data-needs-selection]')) b.disabled = n === 0;
  for (const act of ['start', 'page-up', 'up', 'down', 'page-down', 'end']) {
    document.querySelector(`[data-act="${act}"]`).disabled = n === 0;
  }
}

function makeHead(entry, { selectable = false, inMatch = false } = {}) {
  const el = document.createElement('div');
  el.className = 'head';
  el.dataset.id = entry.id;
  const closed = entry.tabId == null;
  if (closed) el.classList.add('closed');
  if (selectable && state.selected.has(entry.id)) el.classList.add('selected');
  el.title = `${entry.title || entry.url}\n${entry.url}${closed ? '\n(tab is closed - click to open it)' : ''}`;

  if (selectable) {
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'check';
    check.checked = state.selected.has(entry.id);
    check.title = 'Select (Shift+click: select / unselect a range)';
    el.append(check);
  }

  // The live favicon first; the cached copy covers sites that are offline or gone.
  const icon = makeIcon(entry.favIconUrl, entry.url, entry.favIconData);
  if (!inMatch) icon.title = 'Show browser tabs from the same site';
  el.append(icon);

  const text = document.createElement('div');
  text.className = 'text';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = entry.title || displayUrl(entry.url) || '(untitled)';
  text.append(title);
  if (state.settings.showUrl) {
    const url = document.createElement('div');
    url.className = 'url';
    url.textContent = displayUrl(entry.url);
    text.append(url);
  }
  el.append(text);

  const close = document.createElement('button');
  close.className = 'close';
  close.title = "Forget this tab (doesn't close it)";
  close.innerHTML = ICONS.close;
  el.append(close);
  return el;
}

function makeIcon(src, pageUrl, cached = null) {
  const img = document.createElement('img');
  img.className = 'icon';
  img.alt = '';
  img.draggable = false;
  const candidates = [src, cached]
    .filter((s) => s && /^(https?|data):/i.test(s))
    .concat(chromeFaviconUrl(pageUrl));
  let i = 0;
  img.src = candidates[0];
  img.addEventListener('error', () => {
    if (++i < candidates.length) img.src = candidates[i];
    else img.classList.add('missing');
  });
  return img;
}

function entryById(id) {
  return state.entries.find((e) => e.id === id);
}

function wireGrid() {
  const grid = $('#grid');

  grid.addEventListener('click', (ev) => {
    if (consumeSuppressedClick()) return;
    const head = ev.target.closest('.head');
    if (!head) return;
    const id = head.dataset.id;
    const entry = entryById(id);
    if (!entry) return;
    if (ev.target.closest('.close')) forget([id]);
    else if (ev.target.closest('.check')) toggleCheck(id, ev.shiftKey);
    else if (ev.target.closest('.icon')) goToMatchFromList(id);
    else activate(entry);
  });

  // Middle click closes the browser tab (keeps it remembered).
  grid.addEventListener('mousedown', (ev) => {
    if (ev.button === 1 && ev.target.closest('.head')) ev.preventDefault(); // no autoscroll
  });
  grid.addEventListener('auxclick', (ev) => {
    if (ev.button !== 1) return;
    const head = ev.target.closest('.head');
    if (head) closeTabs([head.dataset.id]);
  });

  grid.addEventListener('contextmenu', (ev) => {
    const head = ev.target.closest('.head');
    if (!head) return;
    ev.preventDefault();
    const entry = entryById(head.dataset.id);
    if (!entry) return;
    const id = entry.id;
    const isSel = state.selectMode && state.selected.has(id);
    showMenu(ev.clientX, ev.clientY, [
      { label: isSel ? 'Unselect' : 'Select', action: () => (isSel ? toggleCheck(id, false) : selectOne(id)) },
      '-',
      { label: 'Forget Tab', action: () => forget([id]) },
      { label: 'Close Tab', disabled: entry.tabId == null, action: () => closeTabs([id]) },
      { label: 'Forget and Close Tab', action: () => forgetAndClose([id]) },
    ]);
  });

  grid.addEventListener('dragstart', (ev) => ev.preventDefault());
  grid.addEventListener('pointerdown', onDragPointerDown);
}

function goToMatchFromList(id) {
  location.hash = `#match/${encodeURIComponent(id)}`;
  history.replaceState({ fromList: true }, '');
}

// ---- selection ------------------------------------------------------------------------------

function setSelectMode(on) {
  state.selectMode = on;
  if (!on) {
    state.selected.clear();
    state.anchorId = null;
  }
  render();
}

function selectOne(id) {
  state.selectMode = true;
  state.selected.add(id);
  state.anchorId = id;
  render();
}

function toggleCheck(id, shift) {
  const select = !state.selected.has(id);
  const ids = state.entries.map((e) => e.id);
  const a = shift && state.anchorId != null ? ids.indexOf(state.anchorId) : -1;
  const b = ids.indexOf(id);
  if (a >= 0 && b >= 0) {
    // Shift+click sets the whole range (anchor..clicked) to the clicked checkbox's new state.
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      if (select) state.selected.add(ids[i]);
      else state.selected.delete(ids[i]);
    }
  } else if (select) state.selected.add(id);
  else state.selected.delete(id);
  state.anchorId = id;
  render();
}

function selectAll() {
  state.selectMode = true;
  for (const e of state.entries) state.selected.add(e.id);
  render();
}

// ---- remember all open tabs -------------------------------------------------------------------

/** Appends every open tab (of this window, or of all windows) that isn't remembered yet. */
async function rememberAll(scope) {
  const query = scope === 'window' ? { windowId: (await chrome.windows.getCurrent()).id } : {};
  const tabs = (await chrome.tabs.query(query))
    .filter((t) => !isViewUrl(t.url || t.pendingUrl))
    .sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  let added = [];
  await mutateEntries((entries) => {
    const taken = new Set(entries.map((e) => e.tabId).filter((id) => id != null));
    added = tabs.filter((t) => !taken.has(t.id)).map(newEntry);
    return added.length ? entries.concat(added) : undefined;
  });
  for (const e of added) if (e.favIconUrl) refreshEntryFavicon(e.id, e.favIconUrl, e.url);
  if (!added.length) {
    toast(scope === 'window' ? 'All tabs in this window are already remembered.' : 'All open tabs are already remembered.');
    return;
  }
  const ids = new Set(added.map((e) => e.id));
  toast(`Remembered ${added.length} tab${added.length > 1 ? 's' : ''}`, {
    label: 'Undo',
    action: () => mutateEntries((entries) => entries.filter((e) => !ids.has(e.id))),
  });
}

function selectedIds() {
  return state.entries.filter((e) => state.selected.has(e.id)).map((e) => e.id);
}

// ---- actions on tabs ------------------------------------------------------------------------

async function activate(entry) {
  if (entry.tabId != null) {
    try {
      const tab = await chrome.tabs.update(entry.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch {
      /* the tab is gone; open a new one below */
    }
  }
  if (!entry.url) return;
  let tab;
  try {
    tab = await chrome.tabs.create({ url: entry.url, active: true });
  } catch (err) {
    toast(`Can't open ${displayUrl(entry.url)}: ${err.message || err}`);
    return;
  }
  await linkEntryToTab(entry.id, tab, { takeTabData: false });
}

/**
 * Associates an entry with a browser tab. Any other entry following that tab lets go of it
 * (one tab is followed by at most one entry). With takeTabData the entry's url/title/icon are
 * replaced by the tab's.
 */
async function linkEntryToTab(entryId, tab, { takeTabData }) {
  let fav = null;
  let unlinked = 0;
  await mutateEntries((entries) => {
    const e = entries.find((x) => x.id === entryId);
    if (!e) return undefined;
    for (const o of entries) {
      if (o !== e && o.tabId === tab.id) {
        // When opening an entry, the background may have handed the fresh tab to another entry
        // waiting to re-adopt a tab with that url; that one goes back to waiting.
        o.tabId = null;
        o.rematch = !takeTabData;
        unlinked++;
      }
    }
    e.tabId = tab.id;
    e.rematch = false;
    if (takeTabData) {
      e.url = tab.url || tab.pendingUrl || e.url;
      e.title = tab.title || e.title;
      const f = tab.favIconUrl || '';
      if (f !== e.favIconUrl) {
        e.favIconUrl = f;
        e.favIconData = null;
        fav = f;
      }
    }
    return entries;
  });
  if (fav) refreshEntryFavicon(entryId, fav, tab.url || tab.pendingUrl);
  return unlinked;
}

function tabIdsOf(ids) {
  const set = new Set(ids);
  return state.entries
    .filter((e) => set.has(e.id) && e.tabId != null && e.tabId !== state.myTabId)
    .map((e) => e.tabId);
}

async function closeTabs(ids) {
  const tabIds = tabIdsOf(ids);
  if (tabIds.length) await chrome.tabs.remove(tabIds).catch(() => {});
}

async function forget(ids, { closeToo = false } = {}) {
  const set = new Set(ids);
  const tabIds = closeToo ? tabIdsOf(ids) : [];
  const removed = [];
  await mutateEntries((entries) => {
    const kept = [];
    entries.forEach((e, index) => {
      if (set.has(e.id)) removed.push({ entry: e, index });
      else kept.push(e);
    });
    return removed.length ? kept : undefined;
  });
  for (const id of ids) state.selected.delete(id);
  if (tabIds.length) await chrome.tabs.remove(tabIds).catch(() => {});
  if (!removed.length) return;
  const what = removed.length === 1 ? `"${removed[0].entry.title || displayUrl(removed[0].entry.url)}"` : `${removed.length} tabs`;
  const closedText = tabIds.length ? (tabIds.length > 1 ? ' and closed them' : ' and closed it') : '';
  toast(`Forgot ${what}${closedText}`, {
    label: 'Undo',
    action: () => undoForget(removed),
  });
}

function forgetAndClose(ids) {
  return forget(ids, { closeToo: true });
}

async function undoForget(removed) {
  const tabs = await chrome.tabs.query({});
  const open = new Map(tabs.map((t) => [t.id, t]));
  await mutateEntries((entries) => {
    const have = new Set(entries.map((e) => e.id));
    const taken = new Set(entries.map((e) => e.tabId).filter((x) => x != null));
    for (const { entry, index } of removed) {
      if (have.has(entry.id)) continue;
      const e = { ...entry };
      if (e.tabId != null && (!open.has(e.tabId) || taken.has(e.tabId))) e.tabId = null;
      if (e.tabId != null) taken.add(e.tabId);
      entries.splice(Math.min(index, entries.length), 0, e);
    }
    return entries;
  });
}

// ---- reordering ----------------------------------------------------------------------------------

async function reorder(fn) {
  if (!state.selected.size) return;
  const sel = new Set(state.selected);
  // Optimistic local update so repeated clicks feel instant; storage then confirms it.
  const nextIds = fn(state.entries.map((e) => e.id), sel);
  state.entries = applyOrder(state.entries, nextIds);
  render();
  scrollSelectionIntoView();
  await mutateEntries((entries) => {
    const ids = entries.map((e) => e.id);
    const target = applyOrder(entries, fn(ids, sel));
    return target.every((e, i) => e === entries[i]) ? undefined : target;
  });
}

function scrollSelectionIntoView() {
  const first = document.querySelector('#grid .head.selected');
  first?.scrollIntoView({ block: 'nearest' });
}

function wireTopbar() {
  $('#select-toggle').addEventListener('click', () => setSelectMode(!state.selectMode));
  $('#remember-all').addEventListener('click', (ev) => {
    const r = ev.currentTarget.getBoundingClientRect();
    showMenu(r.left, r.bottom + 4, [
      { label: 'Remember all tabs in this window', action: () => rememberAll('window') },
      { label: 'Remember all tabs in all windows', action: () => rememberAll('all') },
    ]);
  });
  $('#back').addEventListener('click', goToList);
  $('#settings-btn').addEventListener('click', () => $('#settings').showModal());

  const moves = {
    up: [-1, -3],
    down: [1, 3],
    'page-up': [-10, -30],
    'page-down': [10, 30],
  };
  const tools = $('#select-tools');
  const run = (act, alt) => {
    if (moves[act]) {
      const d = moves[act][alt ? 1 : 0];
      reorder((ids, sel) => moveSelectedBy(ids, sel, d));
    } else if (act === 'start') reorder(moveSelectedToStart);
    else if (act === 'end') reorder(moveSelectedToEnd);
    else if (act === 'select-all') selectAll();
    else if (act === 'select-none') {
      state.selected.clear();
      render();
    } else if (act === 'forget') forget(selectedIds());
    else if (act === 'close') closeTabs(selectedIds());
    else if (act === 'forget-close') forgetAndClose(selectedIds());
    else if (act === 'done') setSelectMode(false);
  };
  tools.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (b && !b.disabled) run(b.dataset.act, false);
  });
  // Right-click on the arrow buttons moves 3 / 30 positions.
  tools.addEventListener('contextmenu', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    ev.preventDefault();
    if (!b.disabled && moves[b.dataset.act]) run(b.dataset.act, true);
  });
}

// ---- drag and drop (select mode, dragging selected heads) ----------------------------------------

const DRAG_THRESHOLD = 5;
let suppressClick = false;

function consumeSuppressedClick() {
  if (!suppressClick) return false;
  suppressClick = false;
  return true;
}

function onDragPointerDown(ev) {
  if (!state.selectMode || ev.button !== 0) return;
  const head = ev.target.closest('.head');
  if (!head || !state.selected.has(head.dataset.id)) return;
  if (ev.target.closest('.check, .close')) return;
  state.drag = {
    pointerId: ev.pointerId,
    startX: ev.clientX,
    startY: ev.clientY,
    x: ev.clientX,
    y: ev.clientY,
    started: false,
    beforeId: undefined,
    raf: 0,
  };
  addEventListener('pointermove', onDragMove, true);
  addEventListener('pointerup', onDragEnd, true);
  addEventListener('pointercancel', onDragCancel, true);
}

function onDragMove(ev) {
  const d = state.drag;
  if (!d || ev.pointerId !== d.pointerId) return;
  d.x = ev.clientX;
  d.y = ev.clientY;
  if (!d.started) {
    if (Math.hypot(d.x - d.startX, d.y - d.startY) < DRAG_THRESHOLD) return;
    d.started = true;
    try {
      $('#grid').setPointerCapture(d.pointerId); // keep getting moves outside the window
    } catch {
      /* ignore */
    }
    document.body.classList.add('dragging');
    const ghost = $('#drag-ghost');
    const n = state.selected.size;
    ghost.textContent = `Moving ${n} tab${n > 1 ? 's' : ''}`;
    ghost.hidden = false;
    d.raf = requestAnimationFrame(dragTick);
  }
  const ghost = $('#drag-ghost');
  ghost.style.left = `${d.x + 14}px`;
  ghost.style.top = `${d.y + 14}px`;
}

function dragTick() {
  const d = state.drag;
  if (!d?.started) return;
  // Auto-scroll near the top (just below the sticky bar) and bottom of the viewport.
  const zone = 48;
  const top = $('#topbar').getBoundingClientRect().bottom;
  const bottom = innerHeight;
  let dy = 0;
  if (d.y < top + zone) dy = -Math.min(30, Math.ceil(((top + zone - d.y) / zone) * 18));
  else if (d.y > bottom - zone) dy = Math.min(30, Math.ceil(((d.y - (bottom - zone)) / zone) * 18));
  if (dy) scrollBy(0, dy);
  updateDropTarget(d.x, d.y);
  d.raf = requestAnimationFrame(dragTick);
}

function updateDropTarget(x, y) {
  const d = state.drag;
  const heads = [...document.querySelectorAll('#grid .head')];
  const marker = $('#drop-marker');
  if (!heads.length) return;
  let best = null;
  let bestScore = Infinity;
  let bestRect = null;
  for (const h of heads) {
    const r = h.getBoundingClientRect();
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dyv = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const score = dyv * 10000 + dx; // nearest row first, then nearest head in that row
    if (score < bestScore) {
      bestScore = score;
      best = h;
      bestRect = r;
    }
  }
  const after = x > bestRect.left + bestRect.width / 2;
  const idx = heads.indexOf(best);
  d.beforeId = after ? (heads[idx + 1]?.dataset.id ?? null) : best.dataset.id;
  const gap = parseFloat(getComputedStyle($('#grid')).columnGap) || 6;
  marker.hidden = false;
  marker.style.left = `${(after ? bestRect.right + gap / 2 : bestRect.left - gap / 2) - 1.5}px`;
  marker.style.top = `${bestRect.top}px`;
  marker.style.height = `${bestRect.height}px`;
}

function stopDrag() {
  const d = state.drag;
  removeEventListener('pointermove', onDragMove, true);
  removeEventListener('pointerup', onDragEnd, true);
  removeEventListener('pointercancel', onDragCancel, true);
  if (d?.raf) cancelAnimationFrame(d.raf);
  document.body.classList.remove('dragging');
  $('#drag-ghost').hidden = true;
  $('#drop-marker').hidden = true;
  state.drag = null;
  if (state.renderDeferred) {
    state.renderDeferred = false;
    render();
  }
}

function onDragEnd(ev) {
  const d = state.drag;
  if (!d || ev.pointerId !== d.pointerId) return;
  const { started, beforeId } = d;
  stopDrag();
  if (!started) return;
  suppressClick = true; // the click that follows the drop is not a "focus this tab" click
  setTimeout(() => (suppressClick = false), 0);
  if (beforeId !== undefined) reorder((ids, sel) => moveSelectedBefore(ids, sel, beforeId));
}

function onDragCancel(ev) {
  if (state.drag && ev.pointerId === state.drag.pointerId) stopDrag();
}

// ---- match view: browser tabs on the same site ----------------------------------------------------

let matchRenderSeq = 0;

async function renderMatch() {
  const { entryId } = route();
  const entry = entryById(entryId);
  if (!entry) {
    location.hash = '';
    return;
  }
  const seq = ++matchRenderSeq;
  const tabs = await chrome.tabs.query({});
  if (seq !== matchRenderSeq) return; // a newer render started meanwhile

  $('#match-entry').replaceChildren(makeHead(entry, { inMatch: true }));
  const site = secondLevelDomain(hostOf(entry.url)) || displayUrl(entry.url);
  $('#match-heading').textContent = `Browser tabs on ${site}`;

  const rows = tabs
    .filter((t) => !isViewUrl(t.url || t.pendingUrl))
    .map((t) => ({ tab: t, level: matchLevel(entry.url, t.url || t.pendingUrl || '') }))
    .filter((r) => r.level)
    .sort(
      (a, b) =>
        MATCH_LEVELS.indexOf(a.level) - MATCH_LEVELS.indexOf(b.level) ||
        (a.tab.id === entry.tabId ? -1 : b.tab.id === entry.tabId ? 1 : 0) ||
        a.tab.windowId - b.tab.windowId ||
        a.tab.index - b.tab.index,
    );

  $('#match-list').replaceChildren(...rows.map((r) => makeMatchRow(r.tab, r.level, r.tab.id === entry.tabId)));
  $('#match-empty').hidden = rows.length > 0;
}

function makeMatchRow(tab, level, linked) {
  const url = tab.url || tab.pendingUrl || '';
  const el = document.createElement('div');
  el.className = 'mtab';
  el.dataset.tabId = tab.id;
  el.title = `${tab.title || url}\n${url}\nClick: switch to this browser tab. Right-click: more`;
  el.append(makeIcon(tab.favIconUrl, url));
  const text = document.createElement('div');
  text.className = 'text';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = tab.title || displayUrl(url);
  const u = document.createElement('div');
  u.className = 'url';
  u.textContent = displayUrl(url);
  text.append(title, u);
  el.append(text);
  if (linked) {
    const l = document.createElement('span');
    l.className = 'linked';
    l.textContent = 'Linked';
    l.title = 'This is the browser tab the remembered entry currently follows';
    el.append(l);
  }
  const label = document.createElement('span');
  label.className = `label ${level}`;
  label.textContent = MATCH_LABELS[level];
  el.append(label);
  return el;
}

function wireMatchView() {
  const list = $('#match-list');
  list.addEventListener('click', async (ev) => {
    const row = ev.target.closest('.mtab');
    if (!row) return;
    const tab = await chrome.tabs.get(Number(row.dataset.tabId)).catch(() => null);
    if (!tab) return;
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  });
  list.addEventListener('contextmenu', (ev) => {
    const row = ev.target.closest('.mtab');
    if (!row) return;
    ev.preventDefault();
    const { entryId } = route();
    const entry = entryById(entryId);
    const tabId = Number(row.dataset.tabId);
    if (!entry) return;
    showMenu(ev.clientX, ev.clientY, [
      {
        label: 'Switch to This Tab',
        disabled: entry.tabId === tabId,
        action: async () => {
          const tab = await chrome.tabs.get(tabId).catch(() => null);
          if (!tab) return toast('That tab was closed meanwhile.');
          const unlinked = await linkEntryToTab(entry.id, tab, { takeTabData: true });
          toast(
            unlinked
              ? 'Switched. Another remembered entry that followed this tab is now unlinked (shown as closed).'
              : 'Switched: the remembered entry now follows this tab.',
          );
        },
      },
    ]);
  });

  // The entry shown at the top behaves like in the list (except for selection and the icon).
  const top = $('#match-entry');
  top.addEventListener('click', (ev) => {
    const head = ev.target.closest('.head');
    const entry = head && entryById(head.dataset.id);
    if (!entry) return;
    if (ev.target.closest('.close')) {
      forget([entry.id]);
      goToList();
    } else if (!ev.target.closest('.icon')) activate(entry);
  });
  top.addEventListener('mousedown', (ev) => {
    if (ev.button === 1) ev.preventDefault();
  });
  top.addEventListener('auxclick', (ev) => {
    const head = ev.target.closest('.head');
    if (ev.button === 1 && head) closeTabs([head.dataset.id]);
  });
  top.addEventListener('contextmenu', (ev) => {
    const head = ev.target.closest('.head');
    const entry = head && entryById(head.dataset.id);
    if (!entry) return;
    ev.preventDefault();
    showMenu(ev.clientX, ev.clientY, [
      { label: 'Forget Tab', action: () => (forget([entry.id]), goToList()) },
      { label: 'Close Tab', disabled: entry.tabId == null, action: () => closeTabs([entry.id]) },
      { label: 'Forget and Close Tab', action: () => (forgetAndClose([entry.id]), goToList()) },
    ]);
  });
}

// ---- context menu -----------------------------------------------------------------------------

function showMenu(x, y, items) {
  const menu = $('#menu');
  menu.replaceChildren(
    ...items.map((it) => {
      if (it === '-') return document.createElement('hr');
      const b = document.createElement('button');
      b.textContent = it.label;
      b.disabled = !!it.disabled;
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', () => {
        hideMenu();
        it.action();
      });
      return b;
    }),
  );
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}

function hideMenu() {
  $('#menu').hidden = true;
}

addEventListener(
  'pointerdown',
  (ev) => {
    if (!ev.target.closest('#menu')) hideMenu();
  },
  true,
);
addEventListener('blur', hideMenu);
addEventListener('resize', hideMenu);
addEventListener('scroll', hideMenu, { passive: true });

// ---- keyboard --------------------------------------------------------------------------------

function wireKeyboard() {
  addEventListener('keydown', (ev) => {
    if (ev.target.closest?.('input[type="number"], dialog')) return;
    if (ev.key === 'Escape') {
      if (!$('#menu').hidden) return hideMenu();
      if (state.drag) return stopDrag();
      if (route().view === 'match') return goToList();
      if (state.selectMode) return setSelectMode(false);
    }
    if (ev.altKey && ev.key === 'ArrowLeft' && route().view === 'match') {
      ev.preventDefault();
      goToList();
    }
    if (route().view !== 'list') return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') {
      ev.preventDefault();
      selectAll();
    }
  });
}

// ---- settings ---------------------------------------------------------------------------------

function wireSettings() {
  $('#set-show-url').addEventListener('change', (ev) => saveSettings({ showUrl: ev.target.checked }));
  const width = $('#set-width');
  const saveWidth = debounce(() => {
    const v = Number(width.value);
    if (Number.isFinite(v) && v > 0) saveSettings({ tabWidth: v });
  }, 300);
  width.addEventListener('input', () => {
    const v = Number(width.value);
    if (Number.isFinite(v) && v >= 80 && v <= 800) {
      document.documentElement.style.setProperty('--tab-width', `${v}px`);
    }
    saveWidth();
  });
  width.addEventListener('change', () => (width.value = normalizeSettings({ tabWidth: width.value }).tabWidth));
  $('#shortcuts-link').addEventListener('click', (ev) => {
    ev.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });
  // Click on the backdrop closes the dialog.
  $('#settings').addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget) ev.currentTarget.close();
  });
}

// ---- toast ------------------------------------------------------------------------------------

let toastTimer = 0;

function toast(text, action) {
  const el = $('#toast');
  $('#toast-text').textContent = text;
  const btn = $('#toast-action');
  btn.hidden = !action;
  btn.onclick = null;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => {
      el.hidden = true;
      action.action();
    };
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), action ? 8000 : 4000);
}

function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
