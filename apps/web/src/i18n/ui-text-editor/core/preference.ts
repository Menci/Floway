export interface BootToggleMirror {
  isEnabled: () => boolean;
  sync: (enabled: boolean) => boolean;
  __testing: {
    readStored: () => boolean;
    setReloadHandler: (handler: () => void) => void;
    resetBootState: (enabled?: boolean) => void;
    storageKey: string;
  };
}

// Captures an enabled flag once at boot so a running page mounts or omits the
// editor runtime consistently. Updating to a different value reloads only after
// the new value persists, avoiding reload loops when storage is unavailable.
export const createBootToggleMirror = (storageKey: string): BootToggleMirror => {
  const readStored = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(storageKey) === '1';
    } catch {
      return false;
    }
  };

  const writeStored = (enabled: boolean): boolean => {
    if (typeof window === 'undefined') return false;
    try {
      window.localStorage.setItem(storageKey, enabled ? '1' : '0');
      return true;
    } catch {
      return false;
    }
  };

  let bootEnabled = readStored();
  let reloadHandler = (): void => {
    if (typeof window !== 'undefined') window.location.reload();
  };

  return {
    isEnabled: () => bootEnabled,
    sync(enabled: boolean): boolean {
      const persisted = writeStored(enabled);
      if (enabled !== bootEnabled && persisted) {
        reloadHandler();
        return true;
      }
      return false;
    },
    __testing: {
      readStored,
      setReloadHandler(handler: () => void): void {
        reloadHandler = handler;
      },
      resetBootState(enabled?: boolean): void {
        bootEnabled = enabled ?? readStored();
      },
      storageKey,
    },
  };
};

export const getAltKeyLabel = (): 'Option' | 'Alt' => {
  if (typeof navigator === 'undefined') return 'Alt';
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform ?? navigator.platform ?? navigator.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform) ? 'Option' : 'Alt';
};
