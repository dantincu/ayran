// Shared helper for the sample apps in this folder — wraps the commands a real app
// calls to participate in the window manager's tabs feature: registering a resource
// as a tab, labeling it, and reporting the app's icon set when asked.
window.TabLib = (function () {
  function invoke(cmd, args) {
    return window.__TAURI__.core.invoke(cmd, args)
  }

  // Applies the css/html/javascript snippets the backend hands every web app (platform
  // fixes such as keeping clear of Android's system bars): { code, type } entries,
  // type being "css", "html" or "javascript". Safe to call repeatedly with the same
  // snippets. openTab does this for the ones in the init_window_tab response; the
  // call below also fetches them as soon as the page loads, so the page is right even
  // before its first tab is registered.
  function applySnippets(snippets) {
    ;(snippets || []).forEach(function (snippet) {
      var hash = 0
      var text = snippet.type + snippet.code
      for (var i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0
      var id = 'csdrive-snippet-' + (hash >>> 0).toString(36)
      if (document.getElementById(id)) return
      if (snippet.type === 'css' || snippet.type === 'javascript') {
        var el = document.createElement(snippet.type === 'css' ? 'style' : 'script')
        el.id = id
        el.textContent = snippet.code
        document.head.appendChild(el)
      } else {
        var box = document.createElement('div')
        box.id = id
        box.innerHTML = snippet.code
        document.body.appendChild(box)
      }
    })
  }
  invoke('get_code_snippets').then(applySnippets, function () {})

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
    const response = await invoke('init_window_tab', {
      appVersion: appVersion || 1,
      url: location.href,
      resourceType: resourceType || null,
    })
    applySnippets(response.codeSnippets)
    return response
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

  return { span: span, openTab: openTab, updateTab: updateTab, registerIcons: registerIcons, applySnippets: applySnippets }
})()
