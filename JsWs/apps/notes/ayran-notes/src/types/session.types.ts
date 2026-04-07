import { StorageProviderType } from './storage.types';

export interface ModalDescriptor {
  id: string;
  type: string;
  title: string;
  props: Record<string, unknown>;
  /** Whether the user can manually close this modal */
  closeable: boolean;
  /** Whether this modal can be minimized */
  minimizable: boolean;
}

export type ModalStack = ModalDescriptor[];

export interface AppTab {
  id: string;
  /** Ayran-path URI of the current page */
  uri: string;
  /** Label for display (derived from uri unless overridden) */
  label?: string;
  /** Active modal stack (top of stack is shown) */
  activeModalStack: ModalStack;
  /** Minimized modal stacks for this tab */
  minimizedModalStacks: ModalStack[];
  /** Docking layout state */
  docking: DockingState | null;
}

export interface DockingState {
  enabled: boolean;
  splitRatio: number; // 0..1, percentage for the primary panel
  primaryUri: string;
  secondaryUri: string;
}

export interface AppSession {
  id: string;
  name: string;
  /** Whether session name is synced to notebook name */
  syncNameWithNotebook: boolean;
  storageProviderId: string;
  storageProviderType: StorageProviderType;
  /** Path of the notebook root relative to the storage root */
  notebookRootPath: string;
  tabs: AppTab[];
  currentTabId: string;
}

export interface AppState {
  sessions: AppSession[];
  currentSessionId: string;
  /** Whether the user has accepted legal terms */
  legalAccepted: boolean;
}
