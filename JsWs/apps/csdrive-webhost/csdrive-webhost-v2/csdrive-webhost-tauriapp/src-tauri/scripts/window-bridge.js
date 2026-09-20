// Android: what a secondary window's page gets instead of Tauri's own IPC (see docs/strategies/android-windows-strategy.md).
//
// The page runs in a plain WebView of its own activity (WindowActivity.kt), which has no Tauri bridge. This script,
// served first in every page's <head> (at /@csdrive/window.js), builds `window.__TAURI_INTERNALS__` — what
// `window.__TAURI__` and `@tauri-apps/api` are written against — on top of `window.CsdriveBridge`, the JavaScript
// interface WindowActivity attaches to *this* WebView for *this* window. The page can call its methods; it can't
// change which window they act for (that is fixed by the activity, in Kotlin).
//
//   invoke(cmd, args)        → CsdriveBridge.invoke → Rust runs the command as this window; the answer comes back
//                              through runCallback (or, for raw bytes, a fetch of http://ipc.localhost/raw/<key>).
//   events (plugin:event|*)  → kept here: listeners are registered in this page; Rust delivers an event to this
//                              window with __csdriveEmit(event, payload).
//   dialogs (plugin:dialog|*)→ a native dialog on this window's activity (CsdriveBridge.dialog).
;(function () {
  'use strict'
  var bridge = window.CsdriveBridge
  if (!bridge || window.__TAURI_INTERNALS__) return

  var internals = {}
  var callbacks = new Map()

  // Ids are kept under 2^31 so they pass through the JavaScript interface as a Java int.
  function uid() {
    return window.crypto.getRandomValues(new Uint32Array(1))[0] >>> 1
  }

  function registerCallback(callback, once) {
    var id = uid()
    callbacks.set(id, function (data) {
      if (once) unregisterCallback(id)
      return callback && callback(data)
    })
    return id
  }
  function unregisterCallback(id) {
    callbacks.delete(id)
  }
  function runCallback(id, data) {
    var callback = callbacks.get(id)
    if (callback) callback(data)
    else console.warn('[csdrive] no callback with id ' + id)
  }

  // ── events: listeners live in this page ──────────────────────────────────────────────────────────
  var listeners = Object.create(null) // event -> { eventId -> handlerId }
  var nextEventId = 1
  function listen(payload) {
    var event = payload && payload.event
    if (typeof event !== 'string') throw new Error('An event needs a name.')
    var id = nextEventId++
    ;(listeners[event] || (listeners[event] = Object.create(null)))[id] = payload.handler
    return id
  }
  function unlisten(payload) {
    var byId = listeners[payload.event]
    if (byId && payload.eventId in byId) {
      unregisterCallback(byId[payload.eventId])
      delete byId[payload.eventId]
    }
    return null
  }
  Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
    value: {
      unregisterListener: function (event, eventId) {
        unlisten({ event: event, eventId: eventId })
      }
    }
  })
  // Called by the backend (window_host::emit_if_open) with the event and its payload.
  Object.defineProperty(window, '__csdriveEmit', {
    value: function (event, payload) {
      var byId = listeners[event]
      if (!byId) return
      Object.keys(byId).forEach(function (id) {
        var handler = byId[id]
        if (handler !== undefined) runCallback(handler, { event: event, id: Number(id), payload: payload })
      })
    }
  })

  // ── dialogs ──────────────────────────────────────────────────────────────────────────────────────
  // plugin-dialog's message() sends the buttons as 'Ok', 'OkCancel', 'YesNo', 'YesNoCancel' or one of the
  // *Custom forms; the answer is the label of the button pressed ('Ok', 'Cancel', 'Yes', 'No' or the custom text).
  function buttonLabels(buttons) {
    if (buttons === undefined || buttons === null || buttons === 'Ok') return ['Ok']
    if (buttons === 'OkCancel') return ['Ok', 'Cancel']
    if (buttons === 'YesNo') return ['Yes', 'No']
    if (buttons === 'YesNoCancel') return ['Yes', 'No', 'Cancel']
    if (typeof buttons === 'object') {
      if (buttons.OkCancelCustom) return buttons.OkCancelCustom
      if (buttons.YesNoCancelCustom) return buttons.YesNoCancelCustom
      if (buttons.OkCustom) return [buttons.OkCustom]
    }
    return ['Ok']
  }
  function dialog(command, payload, callback, error) {
    if (command !== 'plugin:dialog|message') {
      runCallback(error, 'This dialog is not available here.')
      return
    }
    var labels = buttonLabels(payload.buttons)
    var answer = registerCallback(function (index) {
      // (A dismissed dialog — Back, a press outside — answers as the last button does: Cancel, No, or the only one.)
      runCallback(callback, labels[index] !== undefined ? labels[index] : labels[labels.length - 1])
    }, true)
    bridge.dialog(String(payload.title || ''), String(payload.message || ''), JSON.stringify(labels), answer)
  }

  // ── invoke ───────────────────────────────────────────────────────────────────────────────────────
  Object.defineProperty(internals, 'invoke', {
    value: function (cmd, payload) {
      return new Promise(function (resolve, reject) {
        var callback = registerCallback(function (r) {
          resolve(r)
          unregisterCallback(error)
        }, true)
        var error = registerCallback(function (e) {
          reject(e)
          unregisterCallback(callback)
        }, true)
        var args = payload === undefined || payload === null ? {} : payload
        try {
          if (cmd === 'plugin:event|listen') return runCallback(callback, listen(args))
          if (cmd === 'plugin:event|unlisten') return runCallback(callback, unlisten(args))
          if (cmd.indexOf('plugin:event|') === 0) return runCallback(error, 'A page cannot emit events.')
          if (cmd.indexOf('plugin:dialog|') === 0) return dialog(cmd, args, callback, error)
          if (args instanceof ArrayBuffer || ArrayBuffer.isView(args)) {
            return runCallback(error, 'Bytes cannot be sent as the request body here: send them as base64 in a JSON object.')
          }
          bridge.invoke(cmd, JSON.stringify(args), callback, error)
        } catch (e) {
          runCallback(error, String(e && e.message ? e.message : e))
        }
      })
    }
  })

  // A response that is raw bytes (an ArrayBuffer) is fetched, once, from the backend by its key.
  Object.defineProperty(window, '__csdriveRaw', {
    value: function (callback, error, key) {
      fetch('http://ipc.localhost/raw/' + key)
        .then(function (response) {
          if (!response.ok) throw new Error('The response is gone.')
          return response.arrayBuffer()
        })
        .then(
          function (bytes) {
            runCallback(callback, bytes)
          },
          function (e) {
            runCallback(error, String(e && e.message ? e.message : e))
          }
        )
    }
  })

  Object.defineProperty(internals, 'transformCallback', { value: registerCallback })
  Object.defineProperty(internals, 'unregisterCallback', { value: unregisterCallback })
  Object.defineProperty(internals, 'runCallback', { value: runCallback })
  Object.defineProperty(internals, 'callbacks', { value: callbacks })
  Object.defineProperty(internals, 'convertFileSrc', {
    value: function (filePath, protocol) {
      return 'http://' + (protocol || 'asset') + '.localhost/' + encodeURIComponent(filePath)
    }
  })
  var label = String(bridge.label())
  Object.defineProperty(internals, 'metadata', {
    value: { currentWindow: { label: label }, currentWebview: { windowLabel: label, label: label } }
  })
  Object.defineProperty(internals, 'plugins', { value: { path: { sep: '/', delimiter: ':' } } })
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: internals })
})()
