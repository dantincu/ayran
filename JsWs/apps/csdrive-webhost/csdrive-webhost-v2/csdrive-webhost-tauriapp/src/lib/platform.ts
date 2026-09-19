import { invokeWithBytes } from './ipcBytes'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { writeFile } from '@tauri-apps/plugin-fs'

import { isMobile } from './isMobile'

export { isMobile }

/** Gives a file to the device's own storage. Desktop: a native "save as" dialog. Android:
 * straight into the Downloads folder (its save dialog yields content URIs the fs scope
 * can't write to — see `device_files.rs`). `read` is only called once we know where to
 * save. Resolves to where the file went, or null if the user cancelled. */
export async function exportToDevice(name: string, read: () => Promise<Uint8Array>): Promise<string | null> {
  if (isMobile) {
    return invokeWithBytes<string>('save_to_device', await read(), { name })
  }
  const dest = await saveDialog({ defaultPath: name })
  if (!dest) return null
  await writeFile(dest, await read())
  return dest
}

export interface PickedFile {
  name: string
  data: Uint8Array
}

/** Lets the user choose files from the device to bring into the app. Uses the webview's
 * own file chooser (an `<input type="file">`), which works the same on every platform —
 * including Android, where the native dialog returns content URIs the fs scope can't
 * cover. Resolves to an empty list if the chooser is dismissed. */
export function pickFilesFromDevice(): Promise<PickedFile[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.style.display = 'none'

    let settled = false
    const finish = (run: () => void) => {
      if (settled) return
      settled = true
      input.remove()
      run()
    }

    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? [])
      Promise.all(files.map(async (file) => ({ name: file.name, data: new Uint8Array(await file.arrayBuffer()) }))).then(
        (picked) => finish(() => resolve(picked)),
        (e) => finish(() => reject(e)),
      )
    })
    // Fires (where supported) when the chooser is dismissed without a choice.
    input.addEventListener('cancel', () => finish(() => resolve([])))

    document.body.appendChild(input)
    input.click()
  })
}
