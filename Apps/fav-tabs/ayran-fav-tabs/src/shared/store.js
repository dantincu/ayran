// Persistence for remembered tabs ("entries") and settings.
//
// Entry shape:
//   id            string   stable id of the entry (two entries may share a url)
//   tabId         number|null  the browser tab it follows; null when that tab is closed
//   url, title    string   last known values of the followed tab
//   favIconUrl    string   last known favicon url of the followed tab
//   favIconData   string|null  the favicon cached as a data: url, so it survives the tab
//   rememberedAt  number   ms timestamp
//   rematch       boolean  the tab went away with its window (or the browser restarted):
//                          the next tab that shows up with exactly the same url is re-adopted
//
// Order of the array = order of the list in the view.
// Every write goes through mutateEntries(), which holds a Web Lock shared by the service
// worker and the view pages, so concurrent read-modify-write cycles cannot lose updates.

export const ENTRIES_KEY = 'entries';
export const SETTINGS_KEY = 'settings';
export const DEFAULT_SETTINGS = Object.freeze({ showUrl: false, tabWidth: 200 });
export const MIN_TAB_WIDTH = 80;
export const MAX_TAB_WIDTH = 800;

export async function getEntries() {
  const r = await chrome.storage.local.get(ENTRIES_KEY);
  return Array.isArray(r[ENTRIES_KEY]) ? r[ENTRIES_KEY] : [];
}

/**
 * Runs fn(entries) under the entries lock. fn may mutate the array in place and/or return
 * a new array; returning `undefined` means "nothing changed" (nothing is written), returning
 * the array (same or new) writes it. Resolves with whatever fn returned.
 */
export function mutateEntries(fn) {
  return navigator.locks.request('ayran-fav-tabs:entries', async () => {
    const entries = await getEntries();
    const result = await fn(entries);
    if (result !== undefined) {
      await chrome.storage.local.set({ [ENTRIES_KEY]: result });
    }
    return result;
  });
}

export function newEntry(tab) {
  return {
    id: crypto.randomUUID(),
    tabId: tab.id ?? null,
    url: tab.url || tab.pendingUrl || '',
    title: tab.title || '',
    favIconUrl: tab.favIconUrl || '',
    favIconData: null,
    rememberedAt: Date.now(),
    rematch: false,
  };
}

export function normalizeSettings(s) {
  const out = { ...DEFAULT_SETTINGS, ...(s || {}) };
  out.showUrl = !!out.showUrl;
  let w = Math.round(Number(out.tabWidth));
  if (!Number.isFinite(w)) w = DEFAULT_SETTINGS.tabWidth;
  out.tabWidth = Math.min(MAX_TAB_WIDTH, Math.max(MIN_TAB_WIDTH, w));
  return out;
}

export async function getSettings() {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(r[SETTINGS_KEY]);
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

// ---- favicons -------------------------------------------------------------------------

const MAX_FAVICON_BYTES = 48 * 1024;

/**
 * Returns the favicon of a page as a data: url, or null if it can't / shouldn't be cached.
 * Without access to the sites themselves, the icon is read from the browser's own favicon
 * store (the extension's `_favicon` endpoint), which is same-origin for the extension.
 */
export async function fetchFaviconData(favIconUrl, pageUrl) {
  if (!favIconUrl) return null;
  if (favIconUrl.startsWith('data:')) {
    return favIconUrl.length <= MAX_FAVICON_BYTES * 1.4 ? favIconUrl : null;
  }
  if (!pageUrl) return null;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 8000);
  try {
    const res = await fetch(chromeFaviconUrl(pageUrl, 32), { signal: abort.signal });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_FAVICON_BYTES) return null;
    let type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!type.startsWith('image/')) type = 'image/png';
    return `data:${type};base64,${toBase64(new Uint8Array(buf))}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Fetches and stores the favicon of one entry, if the entry still has that favicon url. */
export async function refreshEntryFavicon(entryId, favIconUrl, pageUrl) {
  // The browser stores a page's favicon shortly after the tab reports it; give it a moment.
  if (!favIconUrl.startsWith('data:')) await new Promise((r) => setTimeout(r, 1500));
  const data = await fetchFaviconData(favIconUrl, pageUrl);
  await mutateEntries((entries) => {
    const e = entries.find((x) => x.id === entryId);
    if (!e || e.favIconUrl !== favIconUrl || e.favIconData === data) return undefined;
    e.favIconData = data;
    return entries;
  });
}

/** Chrome's own favicon cache for a page url (needs the "favicon" permission). */
export function chromeFaviconUrl(pageUrl, size = 32) {
  return chrome.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(pageUrl || '')}&size=${size}`);
}

export const VIEW_PATH = 'src/view/view.html';
export function viewUrl() {
  return chrome.runtime.getURL(VIEW_PATH);
}
export function isViewUrl(url) {
  return !!url && url.startsWith(viewUrl());
}
