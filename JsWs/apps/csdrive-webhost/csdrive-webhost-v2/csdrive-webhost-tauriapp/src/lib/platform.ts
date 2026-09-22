import { invoke } from '@tauri-apps/api/core'
import { invokeWithBytes } from './ipcBytes'

import { isMobile } from './isMobile'

export { isMobile }

/** What the backend answers when the person declined the confirmation Android asks before writing into Downloads. */
const EXPORT_CANCELLED = 'Cancelled.'

/** Runs an Android export; a declined confirmation is "nothing was saved" (`null`), not an error. */
async function unlessDeclined(run: () => Promise<string>): Promise<string | null> {
  try {
    return await run()
  } catch (e) {
    if (String(e) === EXPORT_CANCELLED) return null
    throw e
  }
}

/** Gives a file to the device's own storage. Desktop: a native "save as" dialog (shown by the backend,
 * which then writes the file wherever the person chose). Android: into the Downloads folder after a native
 * confirmation (its save dialog yields content URIs; see `device_files.rs`). `read` is only called once we know
 * where to save. Resolves to where the file went, or null if the user cancelled. */
export async function exportToDevice(name: string, read: () => Promise<Uint8Array>): Promise<string | null> {
  if (isMobile) {
    return unlessDeclined(async () => invokeWithBytes<string>('save_to_device', await read(), { name }))
  }
  const token = await invoke<string | null>('choose_save_location', { name })
  if (!token) return null
  return invokeWithBytes<string>('save_to_device', await read(), { name, token })
}

export interface PickedFile {
  name: string
  data: Uint8Array
}

/** Exports a file that is already on this device — one Rust copies itself (`export_local_file`,
 * `filen_cache_export`), so its bytes never pass through the page. On desktop this asks where to save
 * first (`run` gets the one-time token for the backend to use), on Android the file goes to
 * Downloads once the person confirms (`run` gets null). Resolves to the name it was saved as, or null if the person cancelled. */
export async function exportPathToDevice(name: string, run: (token: string | null) => Promise<string>): Promise<string | null> {
  if (isMobile) return unlessDeclined(() => run(null))
  const token = await invoke<string | null>('choose_save_location', { name })
  return token ? run(token) : null
}

/** Opens the webview's own file chooser (an `<input type="file">`), which works the same on every
 * platform — including Android, where the native dialog returns content URIs the fs scope can't
 * cover. Resolves to the chosen `File`s *unread* (none if it is dismissed), so a big one can be read
 * and sent on in pieces. The page never learns where a file came from: a `File` has a name, not a path. */
export function pickDeviceFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.style.display = 'none'

    let settled = false
    const finish = (files: File[]) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(files)
    }

    input.addEventListener('change', () => finish(Array.from(input.files ?? [])))
    // Fires (where supported) when the chooser is dismissed without a choice.
    input.addEventListener('cancel', () => finish([]))

    document.body.appendChild(input)
    input.click()
  })
}

/** Like `pickDeviceFiles`, but reads each file whole into memory — for small ones. */
export async function pickFilesFromDevice(): Promise<PickedFile[]> {
  const files = await pickDeviceFiles()
  return Promise.all(files.map(async (file) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) })))
}
