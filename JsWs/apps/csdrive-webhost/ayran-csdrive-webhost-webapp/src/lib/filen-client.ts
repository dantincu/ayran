import FilenSDK from '@filen/sdk';
import { getAccount, upsertAccount } from './token-store';

// In-memory cache — survives within a Node.js process lifetime, rebuilt from stored config on cold start
const sdkCache = new Map<string, FilenSDK>();

function buildSDK(config: Record<string, unknown>): FilenSDK {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new FilenSDK({ ...(config as any), connectToSocket: false });
}

export async function getFilenSDK(accountId: string): Promise<FilenSDK | null> {
  if (sdkCache.has(accountId)) return sdkCache.get(accountId)!;

  const account = await getAccount(accountId);
  if (!account?.providerData || account.provider !== 'filen') return null;

  const sdk = buildSDK(account.providerData);
  sdkCache.set(accountId, sdk);
  return sdk;
}

export async function loginFilen(
  email: string,
  password: string,
  twoFactorCode?: string
): Promise<{ id: string; email: string }> {
  const sdk = new FilenSDK({ connectToSocket: false });
  await sdk.login({ email, password, twoFactorCode });

  const config = sdk.config;
  const id = `filen-${config.userId}`;

  await upsertAccount({
    id,
    email,
    displayName: email.split('@')[0],
    provider: 'filen',
    accessToken: config.apiKey ?? '',
    providerData: config as Record<string, unknown>,
  });

  sdkCache.set(id, sdk);
  return { id, email };
}
