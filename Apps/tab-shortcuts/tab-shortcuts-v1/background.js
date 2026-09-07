const LIST_PAGE_URL = chrome.runtime.getURL("tabs.html");

async function showTabList() {
  const existing = await chrome.tabs.query({ url: LIST_PAGE_URL });

  if (existing.length > 0) {
    const [tab] = existing;
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
    // The page is already loaded - ask it to refresh in case tabs changed since it opened.
    // runtime.sendMessage (not tabs.sendMessage) so the extension page's own onMessage
    // listener reliably receives it, regardless of it not being a content script.
    chrome.runtime.sendMessage({ type: "refresh" }).catch(() => {});
    return;
  }

  await chrome.tabs.create({ url: LIST_PAGE_URL });
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "show-tab-list") showTabList();
});

chrome.action.onClicked.addListener(() => showTabList());
