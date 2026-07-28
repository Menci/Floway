export const flowayTokenStorageKey = 'floway-token';
export const flowaySessionHeader = 'x-floway-session';

const sessionInvalidatedEvent = 'floway-session-invalidated';

const storageAvailable = (): boolean => typeof window !== 'undefined';

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

export const invalidateSession = (expectedToken: string | null): void => {
  if (getSessionToken() !== expectedToken) return;
  clearSessionToken();
  if (!storageAvailable()) return;
  window.dispatchEvent(new Event(sessionInvalidatedEvent));
};

export const onSessionInvalidated = (listener: () => void): (() => void) => {
  if (!storageAvailable()) return () => undefined;
  window.addEventListener(sessionInvalidatedEvent, listener);
  return () => window.removeEventListener(sessionInvalidatedEvent, listener);
};
