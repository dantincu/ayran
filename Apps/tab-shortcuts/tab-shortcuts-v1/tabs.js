const FALLBACK_ICON =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">' +
      '<circle cx="8" cy="8" r="6" fill="none" stroke="#9a9a9a" stroke-width="1.5"/></svg>'
  );

const form = document.getElementById("select-form");
const input = document.getElementById("number-input");
const list = document.getElementById("tab-list");

/** @type {Map<number, {id: number, windowId: number}>} */
let rowsByNumber = new Map();
let selfTabId = null;

async function load() {
  const selfTab = await chrome.tabs.getCurrent();
  selfTabId = selfTab.id;

  const allTabs = await chrome.tabs.query({});
  const otherTabs = allTabs.filter((t) => t.id !== selfTabId);

  const windows = groupByWindow(otherTabs, selfTab.windowId);
  render(windows);
}

function groupByWindow(tabs, currentWindowId) {
  const byWindow = new Map();
  for (const tab of tabs) {
    if (!byWindow.has(tab.windowId)) byWindow.set(tab.windowId, []);
    byWindow.get(tab.windowId).push(tab);
  }
  for (const group of byWindow.values()) {
    group.sort((a, b) => a.index - b.index);
  }

  const windowIds = [...byWindow.keys()].sort((a, b) => {
    if (a === currentWindowId) return -1;
    if (b === currentWindowId) return 1;
    return a - b;
  });

  return windowIds.map((windowId, i) => ({
    windowId,
    isCurrent: windowId === currentWindowId,
    label: windowId === currentWindowId ? "This window" : `Window ${i + 1}`,
    tabs: byWindow.get(windowId),
  }));
}

function render(windows) {
  list.innerHTML = "";
  rowsByNumber = new Map();

  const showHeaders = windows.length > 1;
  let number = 1;

  for (const group of windows) {
    if (showHeaders) {
      const header = document.createElement("li");
      header.className = "window-header";
      header.textContent = group.label;
      list.appendChild(header);
    }

    for (const tab of group.tabs) {
      const rowNumber = number++;
      rowsByNumber.set(rowNumber, { id: tab.id, windowId: tab.windowId });

      const row = document.createElement("li");
      row.className = "tab-row";
      row.dataset.number = String(rowNumber);

      const numberEl = document.createElement("span");
      numberEl.className = "number";
      numberEl.textContent = String(rowNumber);

      const icon = document.createElement("img");
      icon.className = "favicon";
      icon.src = tab.favIconUrl || FALLBACK_ICON;
      icon.addEventListener("error", () => {
        icon.src = FALLBACK_ICON;
      });

      const title = document.createElement("span");
      title.className = "title";
      title.textContent = tab.title || tab.url || "(untitled tab)";

      row.append(numberEl, icon, title);
      row.addEventListener("click", () => selectTab(rowNumber));
      list.appendChild(row);
    }
  }

  updateHighlight();
}

function updateHighlight() {
  const target = parseNumber(input.value);
  for (const row of list.querySelectorAll(".tab-row")) {
    row.classList.toggle("highlighted", target !== null && Number(row.dataset.number) === target);
  }
}

function parseNumber(value) {
  if (!/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}

async function selectTab(number) {
  const target = rowsByNumber.get(number);
  if (!target) return;

  await chrome.windows.update(target.windowId, { focused: true });
  await chrome.tabs.update(target.id, { active: true });
  if (selfTabId !== null) chrome.tabs.remove(selfTabId);
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const target = parseNumber(input.value);
  if (target !== null) selectTab(target);
});

input.addEventListener("input", updateHighlight);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "refresh") {
    input.value = "";
    load();
    input.focus();
  }
});

load();
