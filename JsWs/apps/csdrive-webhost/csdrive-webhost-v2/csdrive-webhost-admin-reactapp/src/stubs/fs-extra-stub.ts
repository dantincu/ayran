/**
 * @filen/sdk's browser build still imports `fs-extra` at the top of several core
 * modules (fs/index.js, cloud/index.js, api/client.js, ...) even though none of
 * that is reachable from the code paths this app actually uses (we only use the
 * Buffer-based fs().readFile/writeFile methods, never the Node-local-path based
 * upload/download helpers). fs-extra's own init code unconditionally probes
 * `fs.realpath.native`, which throws immediately against any minimal browser
 * `fs` polyfill. Since nothing in our usage actually needs real fs-extra behavior,
 * this stub just no-ops (or throws on use) instead of crashing on import.
 */

function unsupported(name: string) {
  return (..._args: unknown[]) => {
    throw new Error(`fs-extra.${name} is not supported in the browser build of this app.`)
  }
}

const stub = new Proxy(
  {},
  {
    get(_target, prop: string) {
      return unsupported(prop)
    },
  },
)

export default stub
