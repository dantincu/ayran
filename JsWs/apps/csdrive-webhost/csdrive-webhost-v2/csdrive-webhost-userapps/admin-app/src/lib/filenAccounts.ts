import FilenSDK from '@filen/sdk'
import { deleteSecret, getSecret, setSecret } from './keychain'
import { joinRelative, mkdirUser, readUserTextFile, userPathExists, writeUserTextFile, RESERVED_CONFIG_DIR } from './localFs'

export interface FilenAccountMeta {
  id: string
  email: string
  displayName: string
}

interface AccountsIndex {
  accounts: FilenAccountMeta[]
  activeId: string | null
}

const INDEX_PATH = joinRelative(RESERVED_CONFIG_DIR, 'filen-accounts.json')
const EMPTY_INDEX: AccountsIndex = { accounts: [], activeId: null }

const sdkCache = new Map<string, FilenSDK>()

async function readIndex(): Promise<AccountsIndex> {
  if (!(await userPathExists(INDEX_PATH))) return { ...EMPTY_INDEX }
  try {
    const text = await readUserTextFile(INDEX_PATH)
    const parsed = JSON.parse(text) as AccountsIndex
    return { accounts: parsed.accounts ?? [], activeId: parsed.activeId ?? null }
  } catch {
    return { ...EMPTY_INDEX }
  }
}

async function writeIndex(index: AccountsIndex): Promise<void> {
  await mkdirUser(RESERVED_CONFIG_DIR)
  await writeUserTextFile(INDEX_PATH, JSON.stringify(index, null, 2))
}

export async function listAccounts(): Promise<AccountsIndex> {
  return readIndex()
}

export async function setActiveAccount(id: string | null): Promise<void> {
  const index = await readIndex()
  index.activeId = id
  await writeIndex(index)
}

/** Restores (or returns the cached) SDK instance for an already-connected account, from the OS keychain. */
export async function getSdkForAccount(id: string): Promise<FilenSDK> {
  const cached = sdkCache.get(id)
  if (cached) return cached

  const stored = await getSecret(id)
  if (!stored) {
    throw new Error(`No stored session for account "${id}". Please reconnect it.`)
  }

  const sdk = new FilenSDK(JSON.parse(stored))
  sdkCache.set(id, sdk)
  return sdk
}

export async function addAccount(params: {
  email: string
  password: string
  twoFactorCode?: string
}): Promise<string> {
  const sdk = new FilenSDK({ metadataCache: true })
  await sdk.login(params)

  await setSecret(params.email, JSON.stringify(sdk.config))
  sdkCache.set(params.email, sdk)

  const index = await readIndex()
  if (!index.accounts.some((a) => a.id === params.email)) {
    index.accounts.push({ id: params.email, email: params.email, displayName: params.email })
  }
  index.activeId = params.email
  await writeIndex(index)

  return params.email
}

export async function removeAccount(id: string): Promise<void> {
  await deleteSecret(id)
  sdkCache.delete(id)

  const index = await readIndex()
  index.accounts = index.accounts.filter((a) => a.id !== id)
  if (index.activeId === id) {
    index.activeId = index.accounts[0]?.id ?? null
  }
  await writeIndex(index)
}
