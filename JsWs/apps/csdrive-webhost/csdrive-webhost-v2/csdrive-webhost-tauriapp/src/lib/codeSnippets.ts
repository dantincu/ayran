import { invoke } from '@tauri-apps/api/core'

/** Code the backend wants every page to apply (platform fixes such as keeping clear of
 * Android's system bars, shared styling). Web apps receive the same list in the
 * `codeSnippets` part of the `init_window_tab` response; the admin-app asks for it
 * directly, so both always match. See `code_snippets.rs`. */
export interface CodeSnippet {
  code: string
  type: 'css' | 'html' | 'javascript'
}

function idFor(snippet: CodeSnippet): string {
  let hash = 0
  for (const ch of snippet.type + snippet.code) hash = (hash * 31 + ch.charCodeAt(0)) | 0
  return `csdrive-snippet-${(hash >>> 0).toString(36)}`
}

/** Adds each snippet to the page (once — applying the same one again does nothing). */
export function applyCodeSnippets(snippets: CodeSnippet[]): void {
  for (const snippet of snippets) {
    const id = idFor(snippet)
    if (document.getElementById(id)) continue

    if (snippet.type === 'css' || snippet.type === 'javascript') {
      const el = document.createElement(snippet.type === 'css' ? 'style' : 'script')
      el.id = id
      el.textContent = snippet.code
      document.head.appendChild(el)
    } else {
      const el = document.createElement('div')
      el.id = id
      el.innerHTML = snippet.code
      document.body.appendChild(el)
    }
  }
}

export async function loadAndApplyCodeSnippets(): Promise<void> {
  try {
    applyCodeSnippets(await invoke<CodeSnippet[]>('get_code_snippets'))
  } catch {
    // Without them the page just isn't adjusted — never block starting up over it.
  }
}
