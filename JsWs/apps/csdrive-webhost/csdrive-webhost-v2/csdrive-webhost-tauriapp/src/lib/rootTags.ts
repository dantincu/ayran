/** Tags on *roots*: the places a file manager browses. A tag is attached to an opaque guid (see
 * `secondaryWindows.ts`), so a root's tags are simply the tags of a guid derived from the root —
 * which means every place that shows the root shows the same tags: the Files tab's root switcher
 * and the tabs (in the System Apps tab) that are looking at it.
 *
 *   - a folder on this device: `root:<rootId>` — `root:user`, `root:ext:<picked path>`;
 *   - a Filen account: `root:filen:<userId>`.
 *
 * (Forgetting a root or disconnecting an account leaves its tags in the database, as with any tag;
 * they come back if the same root is added again.) */

export function rootTagGuid(rootId: string): string {
  return `root:${rootId}`
}

export function filenRootTagGuid(userId: number | string): string {
  return `root:filen:${userId}`
}

/** The root a tab is showing, for the tabs that show one: a Notes tab's resource id names its source
 * (`system:notes?s=local:user&p=…`, `s=filen:123`). Null for every other tab. */
export function rootOfTab(tab: { relativePath: string; resourceId: string }): { guid: string } | null {
  if (tab.relativePath !== 'system:notes') return null
  const query = tab.resourceId.includes('?') ? tab.resourceId.slice(tab.resourceId.indexOf('?') + 1) : ''
  const source = new URLSearchParams(query).get('s')
  if (source?.startsWith('local:')) return { guid: rootTagGuid(source.slice('local:'.length)) }
  if (source?.startsWith('filen:')) return { guid: filenRootTagGuid(source.slice('filen:'.length)) }
  return null
}
