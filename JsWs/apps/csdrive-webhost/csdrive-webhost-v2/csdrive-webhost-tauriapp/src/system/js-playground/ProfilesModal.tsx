import { useState } from 'react'
import { Pencil, Play, Plus, Star, Trash2 } from 'lucide-react'
import Modal from '../../components/Modal'
import IconButton from '../../components/IconButton'
import { confirm } from '../../lib/dialogs'
import type { JsPlaygroundProfile, JsPlaygroundProfiles } from '../../lib/jsPlaygroundProfiles'

/** **Manage profiles…** — the JS Playground's own list of named, saved pieces of JavaScript, one of which
 * (if any) runs automatically whenever a new playground window opens (see CLAUDE.md's "JS Playground").
 * Every change here (add, rename happens from the dedicated editor view instead — see below —, delete,
 * starring one as the one that auto-runs) persists immediately, the same immediacy `CustomTextLocationsModal`
 * already uses for its own list: there's no separate "Save" step for the *list itself*, only for a
 * profile's own code (`onEditProfile` hands that off to a dedicated full-page editor, the same "a text
 * editor is a page, not a popup" choice this app already made everywhere else — see CLAUDE.md's "Text
 * editors are now dedicated pages, not popups"). */
export default function ProfilesModal({
  profiles,
  onChange,
  onEditProfile,
  onRunProfile,
  onClose,
}: {
  profiles: JsPlaygroundProfiles
  onChange: (next: JsPlaygroundProfiles) => void
  onEditProfile: (profile: JsPlaygroundProfile) => void
  onRunProfile: (code: string) => void
  onClose: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const active = profiles.profiles.find((p) => p.id === profiles.activeId) ?? null

  function addProfile() {
    const fresh: JsPlaygroundProfile = { id: crypto.randomUUID(), name: 'New profile', code: '' }
    onChange({ ...profiles, profiles: [...profiles.profiles, fresh] })
    onEditProfile(fresh)
  }

  async function removeProfile(profile: JsPlaygroundProfile) {
    setError(null)
    if (!(await confirm(`Delete the profile "${profile.name}"? Its code can't be recovered afterward.`))) return
    onChange({
      profiles: profiles.profiles.filter((p) => p.id !== profile.id),
      activeId: profiles.activeId === profile.id ? null : profiles.activeId,
    })
  }

  function setActive(profile: JsPlaygroundProfile) {
    onChange({ ...profiles, activeId: profiles.activeId === profile.id ? null : profile.id })
  }

  return (
    <Modal title="JS Playground — profiles" onClose={onClose} wide>
      {error && <div className="error-banner">{error}</div>}
      <p className="muted">
        A profile's own code runs automatically, once, whenever a new playground window opens — the one with the star, if any (the same idea as a
        shell's own profile script). Press the star again to stop running anything automatically.
      </p>
      {active ? <p className="status-banner">"{active.name}" runs automatically when a new playground opens.</p> : null}
      {profiles.profiles.length === 0 ? (
        <p className="muted">No profiles yet.</p>
      ) : (
        <ul className="window-list">
          {profiles.profiles.map((profile) => (
            <li key={profile.id} className="window-item">
              <div className="window-item-row">
                <span className="entry-name window-item-main">{profile.name}</span>
                <span className="row-actions">
                  <IconButton
                    icon={Star}
                    label={profile.id === profiles.activeId ? 'Stop running this automatically' : 'Run this automatically when a new playground opens'}
                    onClick={() => setActive(profile)}
                    className={profile.id === profiles.activeId ? 'js-playground-profile-active' : undefined}
                  />
                  <IconButton icon={Play} label={`Run "${profile.name}" now`} onClick={() => onRunProfile(profile.code)} />
                  <IconButton icon={Pencil} label={`Edit "${profile.name}"`} onClick={() => onEditProfile(profile)} />
                  <IconButton icon={Trash2} label={`Delete "${profile.name}"`} onClick={() => removeProfile(profile)} />
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          Close
        </button>
        <button type="button" className="primary" onClick={addProfile}>
          <Plus size={14} aria-hidden="true" /> Add a profile…
        </button>
      </div>
    </Modal>
  )
}
