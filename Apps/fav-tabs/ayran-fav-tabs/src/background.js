import {
  ENTRIES_KEY,
  getEntries,
  mutateEntries,
  newEntry,
  refreshEntryFavicon,
  viewUrl,
  isViewUrl,
} from './shared/store.js';

// ---- startup reconciliation ---------------------------------------------------------------
// Tab ids are only valid within one browser session. storage.session is empty after a browser
// restart (and after the extension is reloaded/updated), so that's when stored tab ids are
// re-checked against the open tabs. Every event handler waits for this to finish, so a stale
// id can never be mistaken for a new, unrelated tab that happens to get the same id.

const ready = init();

async function init() {
  const { reconciled } = await chrome.storage.session.get('reconciled');
  if (!reconciled) {
    const tabs = await chrome.tabs.query({});
    const byId = new Map(tabs.map((t) => [t.id, t]));
    await mutateEntries((entries) => {
      let changed = false;
      for (const e of entries) {
        if (e.tabId == null) continue;
        const t = byId.get(e.tabId);
        if (!t || tabUrl(t) !== e.url) {
          e.tabId = null;
          e.rematch = true;
          changed = true;
        }
      }
      if (rematchAll(entries, tabs)) changed = true;
      return changed ? entries : undefined;
    });
    await chrome.storage.session.set({ reconciled: true });
    await refreshAllBadges();
  }
}

function tabUrl(tab) {
  return tab.url || tab.pendingUrl || '';
}

/** Re-adopts tabs for entries flagged `rematch`, by exact url. Returns true if anything changed. */
function rematchAll(entries, tabs) {
  const taken = new Set(entries.map((e) => e.tabId).filter((id) => id != null));
  let changed = false;
  for (const e of entries) {
    if (!e.rematch || e.tabId != null) continue;
    const t = tabs.find((x) => !taken.has(x.id) && tabUrl(x) === e.url);
    if (!t) continue;
    e.tabId = t.id;
    e.rematch = false;
    taken.add(t.id);
    changed = true;
  }
  return changed;
}

chrome.runtime.onInstalled.addListener(async () => {
  // Right-clicking the toolbar icon shows the browser's menu for it; this puts our entry on top.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'open-view', title: 'Open the Fav Tabs list', contexts: ['action'] });
  });
  await ready;
  await refreshAllBadges();
});

// ---- toolbar icon, its context menu, and commands ---------------------------------------------

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== 'open-view') return;
  await ready;
  await openView();
});

chrome.action.onClicked.addListener(async (tab) => {
  await ready;
  if (isViewUrl(tabUrl(tab))) {
    await openView();
    return;
  }
  await toggleTab(tab);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  await ready;
  if (command === 'open-view') {
    await openView();
  } else if (command === 'toggle-tab') {
    const t = tab ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (t && !isViewUrl(tabUrl(t))) await toggleTab(t);
  }
});

async function toggleTab(tab) {
  let added = null;
  await mutateEntries((entries) => {
    const i = entries.findIndex((e) => e.tabId === tab.id);
    if (i >= 0) {
      entries.splice(i, 1);
    } else {
      added = newEntry(tab);
      entries.push(added);
    }
    return entries;
  });
  if (added && added.favIconUrl) refreshEntryFavicon(added.id, added.favIconUrl, added.url);
}

// Debug handle, e.g. from the service worker's DevTools console: await favTabs.toggleTab(tab)
self.favTabs = { toggleTab, openView, ready };

async function openView() {
  const base = viewUrl();
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => tabUrl(t).startsWith(base));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: base });
  }
}

// ---- following remembered tabs -------------------------------------------------------------

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!('url' in changeInfo || 'title' in changeInfo || 'favIconUrl' in changeInfo || changeInfo.status === 'complete')) {
    return;
  }
  await ready;
  const toFetch = [];
  await mutateEntries((entries) => {
    let changed = false;
    let followed = false;
    for (const e of entries) {
      if (e.tabId !== tabId) continue;
      followed = true;
      const url = tabUrl(tab);
      if (url && e.url !== url) {
        e.url = url;
        changed = true;
      }
      if (tab.title && e.title !== tab.title) {
        e.title = tab.title;
        changed = true;
      }
      // Favicons arrive after the url changes. Take a new one as soon as it's reported, and
      // when loading completes take whatever the tab ends up with (possibly none).
      const fav = tab.favIconUrl || '';
      if (('favIconUrl' in changeInfo || changeInfo.status === 'complete') && e.favIconUrl !== fav) {
        e.favIconUrl = fav;
        e.favIconData = null;
        changed = true;
        if (fav) toFetch.push([e.id, fav, e.url]);
      }
    }
    if (!followed && ('url' in changeInfo || changeInfo.status === 'complete')) {
      if (rematchAll(entries, [tab])) changed = true;
    }
    return changed ? entries : undefined;
  });
  for (const [id, fav, pageUrl] of toFetch) refreshEntryFavicon(id, fav, pageUrl);
  if ('url' in changeInfo || changeInfo.status) refreshBadge(tabId);
});

chrome.tabs.onCreated.addListener(async (tab) => {
  await ready;
  if (!tabUrl(tab)) return;
  await mutateEntries((entries) => (rematchAll(entries, [tab]) ? entries : undefined));
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  await ready;
  await mutateEntries((entries) => {
    let changed = false;
    for (const e of entries) {
      if (e.tabId !== tabId) continue;
      e.tabId = null;
      // Tabs that go away with their window may come back with it (reopened window,
      // browser restart); those get re-adopted by url.
      e.rematch = !!removeInfo.isWindowClosing;
      changed = true;
    }
    return changed ? entries : undefined;
  });
});

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  await ready;
  await mutateEntries((entries) => {
    let changed = false;
    for (const e of entries) {
      if (e.tabId === removedTabId) {
        e.tabId = addedTabId;
        changed = true;
      }
    }
    return changed ? entries : undefined;
  });
  refreshBadge(addedTabId);
});

// ---- badge: shows on tabs that are remembered -----------------------------------------------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[ENTRIES_KEY]) return;
  const before = new Set((changes[ENTRIES_KEY].oldValue || []).map((e) => e.tabId).filter((x) => x != null));
  const after = new Set((changes[ENTRIES_KEY].newValue || []).map((e) => e.tabId).filter((x) => x != null));
  for (const id of before) if (!after.has(id)) setBadge(id, false);
  for (const id of after) if (!before.has(id)) setBadge(id, true);
});

async function refreshBadge(tabId) {
  const entries = await getEntries();
  setBadge(tabId, entries.some((e) => e.tabId === tabId));
}

async function refreshAllBadges() {
  const [entries, tabs] = await Promise.all([getEntries(), chrome.tabs.query({})]);
  const remembered = new Set(entries.map((e) => e.tabId));
  for (const t of tabs) setBadge(t.id, remembered.has(t.id));
}

function setBadge(tabId, remembered) {
  const ignore = () => {}; // the tab may be gone already
  chrome.action.setBadgeText({ tabId, text: remembered ? '★' : '' }).catch(ignore);
  chrome.action
    .setTitle({
      tabId,
      title: remembered
        ? 'Forget this tab (right-click: open the list)'
        : 'Remember this tab (right-click: open the list)',
    })
    .catch(ignore);
  if (remembered) chrome.action.setBadgeBackgroundColor({ tabId, color: '#2e7d32' }).catch(ignore);
}
