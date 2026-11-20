const STORAGE_KEY = 'floway.uiTextEditorEnabled';

const readStored = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

const writeStored = (enabled: boolean): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
    return true;
  } catch {
    return false;
  }
};

// Captured once at module load so the running page has a single, immutable
// decision for whether the UI text editor runtime is mounted. Toggling the
// preference or signing into an account with a different setting updates the
// mirror and reloads only after the new value actually persisted, avoiding
// reload loops when storage is unavailable or full.
let bootEnabled = readStored();

let reloadHandler = (): void => {
  if (typeof window !== 'undefined') window.location.reload();
};

export const isUiTextEditorEnabled = (): boolean => bootEnabled;

export const syncUiTextEditorPreference = (enabled: boolean): boolean => {
  const persisted = writeStored(enabled);
  if (enabled !== bootEnabled && persisted) {
    reloadHandler();
    return true;
  }
  return false;
};

export const __testing = {
  readStored,
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
