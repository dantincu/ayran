import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import IconButton from './IconButton'
import { highlight, type Language } from '../lib/highlight'
import { copyToOsClipboard } from '../lib/clipboard'

/** A read-only, syntax-highlighted code block with a copy-to-clipboard button (the Help tab's snippets; anywhere
 * else a short piece of code is shown for reading, not editing — `CodeEditor` is for editing). */
export default function CodeBlock({ code, language, onError }: { code: string; language: Language; onError?: (message: string) => void }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await copyToOsClipboard(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch (e) {
      onError?.(String(e))
    }
  }

  return (
    <div className="code-block">
      <IconButton icon={copied ? Check : Copy} label={copied ? 'Copied' : 'Copy'} onClick={copy} className="code-block-copy" />
      <pre>
        <code dangerouslySetInnerHTML={{ __html: highlight(code, language) }} />
      </pre>
    </div>
  )
}
