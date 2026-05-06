import FilenSDK from '@filen/sdk';
import { upsertAccount } from './account-store';
import type { StoredAccount } from '../types';

// In-memory cache keyed by account ID.
const cache = new Map<string, FilenSDK>();

export function getFilenSDK(account: StoredAccount): FilenSDK {
  if (cache.has(account.id)) return cache.get(account.id)!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk = new FilenSDK({ ...(account.providerData as any), connectToSocket: false });
  cache.set(account.id, sdk);
  return sdk;
}

export async function loginFilen(
  email: string,
  password: string,
  twoFactorCode?: string
): Promise<StoredAccount> {
  const sdk = new FilenSDK({ connectToSocket: false });
  await sdk.login({ email, password, twoFactorCode });

  const config = sdk.config;
  const id = `filen-${config.userId}`;

  const account: StoredAccount = {
    id,
    email,
    displayName: email.split('@')[0],
    provider: 'filen',
    accessToken: config.apiKey ?? '',
    providerData: config as Record<string, unknown>,
  };

  await upsertAccount(account);
  cache.set(id, sdk);
  return account;
}