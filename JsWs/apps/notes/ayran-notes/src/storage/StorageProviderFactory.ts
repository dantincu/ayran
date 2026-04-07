import { IStorageProvider, StorageProviderType, StorageProviderConfig } from '../types/storage.types';
import { LocalStorageProvider } from './local/LocalStorageProvider';
import { GoogleDriveProvider } from './google-drive/GoogleDriveProvider';
import { OneDriveProvider } from './onedrive/OneDriveProvider';
import { DropboxProvider } from './dropbox/DropboxProvider';
import { FilenProvider } from './filen/FilenProvider';

let providerCache: Map<string, IStorageProvider> = new Map();

export function getStorageProvider(id: string): IStorageProvider | undefined {
  return providerCache.get(id);
}

export function createStorageProvider(
  id: string,
  config: StorageProviderConfig,
): IStorageProvider {
  let provider: IStorageProvider;

  switch (config.type) {
    case StorageProviderType.Local:
      provider = new LocalStorageProvider(id, config.rootPath ?? LocalStorageProvider.getDefaultRoot());
      break;

    case StorageProviderType.GoogleDrive:
      provider = new GoogleDriveProvider(id, config.authData?.clientId ?? '');
      break;

    case StorageProviderType.OneDrive:
      provider = new OneDriveProvider(id, config.authData?.clientId ?? '');
      break;

    case StorageProviderType.Dropbox:
      provider = new DropboxProvider(id, config.authData?.clientId ?? '');
      break;

    case StorageProviderType.Filen:
      provider = new FilenProvider(id);
      break;

    default:
      throw new Error(`Unknown storage provider type: ${(config as StorageProviderConfig).type}`);
  }

  providerCache.set(id, provider);
  return provider;
}

export function registerStorageProvider(provider: IStorageProvider): void {
  providerCache.set(provider.id, provider);
}

export function clearStorageProviders(): void {
  providerCache = new Map();
}
