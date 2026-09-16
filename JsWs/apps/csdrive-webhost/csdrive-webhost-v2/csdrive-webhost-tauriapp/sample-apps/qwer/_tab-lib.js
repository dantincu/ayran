// Shared helper for the sample apps in this folder — wraps the commands a real app
// calls to participate in the window manager's tabs feature: registering a resource
// as a tab, labeling it, and reporting the app's icon set when asked.
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
  // query string just set, e.g. "qwer/index2.html?file=notes.txt". `resourceType`
  // is optional here — it can be set later (or changed) via updateTab instead.
  async function openTab(params, appVersion, resourceType) {
    setQuery(params)
    return invoke('init_window_tab', {
      appVersion: appVersion || 1,
      url: location.href,
      resourceType: resourceType || null,
    })
  }

  // Sets (or replaces) a tab's two-line label, and optionally its resource type
  // (the key into this app's icon set — see registerIcons) and/or its resource id
  // — pass this when the tab has navigated to a different view without opening a
  // new tab for it. Omitting either leaves that field as it was.
  async function updateTab(tabGuid, firstRow, secondRow, resourceType, resourceId) {
    return invoke('update_tab_resource', {
      tabGuid,
      tabText: { firstRow: firstRow, secondRow: secondRow },
      resourceType: resourceType || null,
      resourceId: resourceId || null,
    })
  }

  // Registers this app's icon set (a plain object of resourceType -> SVG markup)
  // and arranges to report it whenever the backend asks — which happens once per
  // app_version this app ever passes to openTab/init_window_tab (including the
  // very first time). Returns a promise that resolves once the listener is actually
  // registered — await it before opening any tabs, or a request-resource-icons
  // event fired that fast could be missed (event.listen's own registration is
  // itself async, it doesn't queue events sent before it resolves).
  function registerIcons(icons) {
    return window.__TAURI__.event.listen('request-resource-icons', function () {
      invoke('submit_resource_icons', { icons: icons })
    })
  }

  return { span: span, openTab: openTab, updateTab: updateTab, registerIcons: registerIcons }
})()
