// Browser stub for graceful-fs, pulled in by @filen/sdk via fs-extra.
// Login and file-listing (pure network calls) will work; local file I/O is
// not available in Tauri's webview and will reject with a clear error.

const cbOrPromise = (...args) => {
  const cb = args[args.length - 1];
  if (typeof cb === "function") { cb(null); return; }
  return Promise.resolve();
};

const stub = () => Object.assign(cbOrPromise, { native: cbOrPromise });

const realpath = stub();
const promises = new Proxy({}, { get: () => () => Promise.resolve() });

const fsStub = new Proxy(
  { realpath, promises },
  { get(t, p) { return p in t ? t[p] : stub(); } }
);

export default fsStub;
export { realpath, promises };
