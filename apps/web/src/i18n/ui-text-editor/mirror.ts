const STORAGE_KEY = 'floway.uiTextEditorEnabled';

const readStored = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

const writeStored = (enabled: boolean): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // Private browsing or quota errors must not crash preference sync.
  }
};

// Captured once at module load so the running page has a single, immutable
// decision for whether the UI text editor runtime is mounted. Toggling the
// preference or signing into an account with a different setting updates the
// mirror and reloads the page to enter or leave the mode cleanly.
let bootEnabled = readStored();

let reloadHandler = (): void => {
  if (typeof window !== 'undefined') window.location.reload();
};

export const isUiTextEditorEnabled = (): boolean => bootEnabled;

export const readUiTextEditorMirror = (): boolean => readStored();

export const syncUiTextEditorPreference = (enabled: boolean): boolean => {
  writeStored(enabled);
  if (enabled !== bootEnabled) {
    reloadHandler();
    return true;
  }
  return false;
};

export const __testing = {
  setReloadHandler(handler: () => void): void {
    reloadHandler = handler;
  },
  resetBootState(enabled?: boolean): void {
    bootEnabled = enabled ?? readStored();
  },
  storageKey: STORAGE_KEY,
};

export const getAltKeyLabel = (): 'Option' | 'Alt' => {
  if (typeof navigator === 'undefined') return 'Alt';
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform) ? 'Option' : 'Alt';
};
