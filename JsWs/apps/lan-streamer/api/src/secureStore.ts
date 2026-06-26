/**
 * OS-native secure storage for small secrets (the session-encryption key),
 * tying decryption to the OS user account this process runs as, rather than
 * to mere possession of a file. Each platform implementation exports the
 * same `protect`/`unprotect` shape; add `secureStore.darwin.ts` (Keychain,
 * e.g. via the `security` CLI) or `secureStore.linux.ts` (libsecret, e.g.
 * via `secret-tool`) and wire them in below when those platforms are needed.
 */
export interface SecureStore {
  protect(data: Buffer): Promise<Buffer>;
  unprotect(data: Buffer): Promise<Buffer>;
}

async function loadSecureStore(): Promise<SecureStore> {
  switch (process.platform) {
    case "win32":
      return import("./secureStore.windows.js");
    default:
      throw new Error(
        `No OS-native secure store implemented for platform "${process.platform}" yet. ` +
          "See api/src/secureStore.windows.ts for the pattern to follow.",
      );
  }
}

let cached: Promise<SecureStore> | undefined;

export function secureStore(): Promise<SecureStore> {
  if (!cached) cached = loadSecureStore();
  return cached;
}
