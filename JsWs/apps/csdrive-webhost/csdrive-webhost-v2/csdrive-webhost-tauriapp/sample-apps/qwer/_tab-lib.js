// Shared helper for the sample apps in this folder — wraps the two commands a real
// app calls to participate in the window manager's tabs feature, plus a tiny helper
// for building the styled-span rows `update_tab_resource` expects.
window.TabLib = (function () {
  function invoke(cmd, args) {
    return window.__TAURI__.core.invoke(cmd, args)
  }

  // One span of text inside a tab label row: { text, bold?, italic? }.
  function span(text, opts) {
    opts = opts || {}
    return { text: String(text), bold: !!opts.bold, italic: !!opts.italic }
  }

  // Replaces this page's query string (via pushState, no reload) with `params`,
  // so location.href — what init_window_tab reads — identifies this resource.
  function setQuery(params) {
    const url = new URL(location.href)
    url.search = ''
    for (const key in params) url.searchParams.set(key, String(params[key]))
    history.pushState(null, '', url)
  }

  // Registers the resource named by `params` as a new tab. Returns
  // { tabGuid, resourceId } — resourceId is this page's relative path plus the
  // query string just set, e.g. "qwer/index2.html?file=notes.txt".
  async function openTab(params, appVersion) {
    setQuery(params)
    return invoke('init_window_tab', { appVersion: appVersion || 1, url: location.href })
  }

  // Sets (or replaces) a tab's two-line label.
  async function updateTab(tabGuid, firstRow, secondRow) {
    return invoke('update_tab_resource', { tabGuid, tabText: { firstRow: firstRow, secondRow: secondRow } })
  }

  return { span: span, openTab: openTab, updateTab: updateTab }
})()
