import { useState, useRef, useEffect } from 'react'
import { X, Minus, Maximize2, Send, Loader2, ChevronDown, ChevronUp } from 'lucide-react'
import { useEmailStore } from '../../stores/emailStore'
import { useAuthStore } from '../../stores/authStore'
import { sendEmail } from '../../services/emailService'

const MODE_LABELS = {
  compose: 'New Message',
  reply: 'Reply',
  replyAll: 'Reply All',
  forward: 'Forward',
}

export function ComposeModal() {
  const { compose, closeCompose } = useEmailStore()
  const { getActiveAccount } = useAuthStore()
  const [minimized, setMinimized] = useState(false)
  const [maximized, setMaximized] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showCcBcc, setShowCcBcc] = useState(false)
  const [form, setForm] = useState({
    to: compose?.to ?? '',
    cc: compose?.cc ?? '',
    bcc: compose?.bcc ?? '',
    subject: compose?.subject ?? '',
    body: compose?.body ?? '',
  })

  const toRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (compose) {
      setForm({
        to: compose.to,
        cc: compose.cc,
        bcc: compose.bcc,
        subject: compose.subject,
        body: compose.body,
      })
      setMinimized(false)
      if (compose.mode === 'compose') {
        setTimeout(() => toRef.current?.focus(), 0)
      } else {
        setTimeout(() => bodyRef.current?.focus(), 0)
      }
    }
  }, [compose])

  if (!compose) return null

  const handleSend = async () => {
    const account = getActiveAccount()
    if (!account) {
      setError('No active account')
      return
    }
    if (!form.to.trim()) {
      setError('Please enter at least one recipient')
      return
    }
    setSending(true)
    setError(null)
    try {
      await sendEmail(account, {
        ...compose,
        ...form,
      })
      closeCompose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send email')
    } finally {
      setSending(false)
    }
  }

  const containerClass = maximized
    ? 'fixed inset-4 z-50 flex flex-col bg-white rounded-xl shadow-2xl border border-gray-200'
    : minimized
    ? 'fixed bottom-0 right-4 z-50 w-80 bg-white rounded-t-xl shadow-2xl border border-gray-200'
    : 'fixed bottom-0 right-4 z-50 w-[560px] bg-white rounded-t-xl shadow-2xl border border-gray-200'

  return (
    <div className={containerClass}>
      {/* Title bar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-gray-800 rounded-t-xl">
        <h3 className="text-sm font-medium text-white">
          {MODE_LABELS[compose.mode]}
        </h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setMinimized((v) => !v)}
            className="p-1 rounded text-gray-300 hover:text-white hover:bg-gray-700 transition-colors"
          >
            {minimized ? <ChevronUp size={14} /> : <Minus size={14} />}
          </button>
          <button
            onClick={() => setMaximized((v) => !v)}
            className="p-1 rounded text-gray-300 hover:text-white hover:bg-gray-700 transition-colors"
          >
            <Maximize2 size={14} />
          </button>
          <button
            onClick={closeCompose}
            className="p-1 rounded text-gray-300 hover:text-white hover:bg-gray-700 transition-colors"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {!minimized && (
        <>
          {/* Form */}
          <div className="flex flex-col flex-1 overflow-hidden">
            {/* Recipients */}
            <div className="border-b border-gray-100">
              <div className="flex items-center px-4 py-2">
                <label className="text-xs text-gray-400 w-8">To</label>
                <input
                  ref={toRef}
                  value={form.to}
                  onChange={(e) => setForm((f) => ({ ...f, to: e.target.value }))}
                  className="flex-1 text-sm text-gray-800 outline-none placeholder:text-gray-300"
                  placeholder="Recipients"
                />
                <button
                  onClick={() => setShowCcBcc((v) => !v)}
                  className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-0.5"
                >
                  Cc/Bcc
                  {showCcBcc ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                </button>
              </div>
              {showCcBcc && (
                <>
                  <div className="flex items-center px-4 py-1.5 border-t border-gray-50">
                    <label className="text-xs text-gray-400 w-8">Cc</label>
                    <input
                      value={form.cc}
                      onChange={(e) => setForm((f) => ({ ...f, cc: e.target.value }))}
                      className="flex-1 text-sm text-gray-800 outline-none placeholder:text-gray-300"
                      placeholder="Cc"
                    />
                  </div>
                  <div className="flex items-center px-4 py-1.5 border-t border-gray-50">
                    <label className="text-xs text-gray-400 w-8">Bcc</label>
                    <input
                      value={form.bcc}
                      onChange={(e) => setForm((f) => ({ ...f, bcc: e.target.value }))}
                      className="flex-1 text-sm text-gray-800 outline-none placeholder:text-gray-300"
                      placeholder="Bcc"
                    />
                  </div>
                </>
              )}
            </div>
            <div className="flex items-center px-4 py-2 border-b border-gray-100">
              <label className="text-xs text-gray-400 w-14">Subject</label>
              <input
                value={form.subject}
                onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))}
                className="flex-1 text-sm text-gray-800 outline-none placeholder:text-gray-300"
                placeholder="Subject"
              />
            </div>

            {/* Body */}
            <textarea
              ref={bodyRef}
              value={form.body}
              onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
              className={`flex-1 px-4 py-3 text-sm text-gray-800 resize-none outline-none placeholder:text-gray-300 ${
                maximized ? 'min-h-0' : 'h-48'
              }`}
              placeholder="Write your message..."
            />
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
            <div>
              {error && <p className="text-xs text-red-500">{error}</p>}
            </div>
            <button
              onClick={handleSend}
              disabled={sending}
              className="flex items-center gap-2 px-4 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
