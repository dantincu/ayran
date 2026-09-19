import { invoke } from '@tauri-apps/api/core'
import { isMobile } from './isMobile'

/** Calls a backend command that takes a file's bytes together with a few text arguments
 * (`filen_write_file`, `save_to_device`; see `ipc.rs`).
 *
 * Desktop: the bytes are the raw request body and the arguments go in percent-encoded
 * headers — the fast path. Android's webview can't pass a POST body to a custom protocol,
 * so there Tauri would turn the bytes into a JSON array of numbers (tens of millions of
 * values for a big file); a base64 string in a JSON object is roughly 3× smaller and cheap
 * to parse instead. */
export async function invokeWithBytes<T = void>(cmd: string, bytes: Uint8Array, fields: Record<string, string>): Promise<T> {
  if (isMobile) return invoke<T>(cmd, { ...fields, data: await toBase64(bytes) })
  const headers = Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, encodeURIComponent(value)]))
  return invoke<T>(cmd, bytes, { headers })
}

/** Base64 of a (possibly large) byte array, without building a giant intermediate string of chars. */
function toBase64(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(new Blob([bytes as BlobPart]))
  })
}
