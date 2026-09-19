import { invoke } from '@tauri-apps/api/core'

/** A small standalone app that can be deployed as a new folder of content into
 * any folder the Files tab can browse — see `deployable_apps.rs`. */
export interface DeployableAppInfo {
  id: string
  name: string
  defaultFolderName: string
}

export async function listDeployableApps(): Promise<DeployableAppInfo[]> {
  return invoke<DeployableAppInfo[]>('list_deployable_apps')
}

/** The embedded `index.html` content for a deployable app — write it into the
 * new folder yourself via whichever file-writing API applies to where you're
 * deploying it (see `writeRootTextFile` in `fileRoots.ts`). */
export async function getDeployableAppHtml(appId: string): Promise<string> {
  return invoke<string>('get_deployable_app_html', { appId })
}
