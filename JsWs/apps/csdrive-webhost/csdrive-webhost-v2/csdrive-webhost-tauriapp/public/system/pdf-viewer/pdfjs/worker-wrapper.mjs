// A one-line-of-real-code wrapper around the vendored pdf.worker.mjs — see PdfViewerApp.tsx's own
// `Promise.withResolvers` polyfill comment for the full story: a worker has its own separate global
// scope, so the main thread's polyfill never reaches code running inside this worker, and pdf.js's own
// worker code uses `Promise.withResolvers` internally (found live on the Android emulator's WebView
// 113.0.5672.136, which doesn't have it). Installed here, synchronously, before the dynamic `import()`
// of the real worker module runs its own top-level code.
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve, reject
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
}
await import('./pdf.worker.mjs')
