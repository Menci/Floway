export const flowayTokenStorageKey = "floway-token";
export const flowaySessionHeader = "x-floway-session";

const storageAvailable = (): boolean => typeof window !== "undefined";

export const getSessionToken = (): string | null => {
  if (!storageAvailable()) return null;
  return window.localStorage.getItem(flowayTokenStorageKey);
};

export const setSessionToken = (token: string): void => {
  if (!storageAvailable()) return;
  window.localStorage.setItem(flowayTokenStorageKey, token);
};

export const clearSessionToken = (): void => {
  if (!storageAvailable()) return;
  window.localStorage.removeItem(flowayTokenStorageKey);
};
