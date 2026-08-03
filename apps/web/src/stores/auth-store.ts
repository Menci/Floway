import { create } from 'zustand';
import type { StoreApi } from 'zustand';

import { getCurrentSession, type AuthUser, type LoginResponse } from '../api/auth';
import { api, callApiNoContent, type GlobalError } from '../api/client';
import { clearSessionToken, getSessionToken, onSessionInvalidated, setSessionToken } from '../auth/session';

// ../auth/session.ts owns the token. The store holds only what the gateway
// answered for one, and holds the two together, so a cached user can never be
// read against a token it did not come from.
interface AuthSession {
  token: string;
  user: AuthUser;
}

interface AuthStore {
  session: AuthSession | null;
  error: GlobalError | null;
  clear: () => void;
  logout: () => Promise<void>;
  initialize: () => Promise<AuthUser | null>;
  refresh: () => Promise<AuthUser | null>;
  primeFromLogin: (login: LoginResponse) => void;
}

let sessionRequest: {
  id: object;
  token: string;
  promise: Promise<AuthUser | null>;
} | null = null;

const sessionFor = (get: StoreApi<AuthStore>['getState'], token: string | null): AuthSession | null => {
  const { session } = get();
  return session?.token === token ? session : null;
};

const loadSession = (
  set: StoreApi<AuthStore>['setState'],
  get: StoreApi<AuthStore>['getState'],
  force: boolean,
): Promise<AuthUser | null> => {
  const token = getSessionToken();
  if (!token) {
    get().clear();
    return Promise.resolve(null);
  }

  const cached = sessionFor(get, token);
  // The in-flight check comes first: a pending request keeps the previous user
  // in place when the token is unchanged, so the cached-session fast path below
  // would otherwise resolve a caller from an identity the request may replace.
  if (sessionRequest?.token === token) return sessionRequest.promise;
  if (!force && cached) return Promise.resolve(cached.user);

  set({ session: cached, error: null });
  const requestId = {};
  const promise = getCurrentSession().then(result => {
    if (sessionRequest?.id !== requestId || getSessionToken() !== token) {
      return sessionFor(get, getSessionToken())?.user ?? null;
    }
    sessionRequest = null;
    if (result.data) {
      set({ session: { token, user: result.data.user }, error: null });
      return result.data.user;
    }
    if (result.error.status === 401) {
      get().clear();
      return null;
    }
    set({ session: sessionFor(get, token), error: result.error });
    return null;
  });
  sessionRequest = { id: requestId, token, promise };
  return promise;
};

export const useAuthStore = create<AuthStore>((set, get) => ({
  session: null,
  error: null,

  clear: () => {
    sessionRequest = null;
    clearSessionToken();
    set({
      session: null,
      error: null,
    });
  },

  // Local logout intent takes precedence when server-side revocation fails --
  // transport or status alike; the gateway expires any surviving session
  // independently.
  logout: async () => {
    await callApiNoContent(() => api.auth.logout.$post());
    get().clear();
  },

  initialize: () => loadSession(set, get, false),
  refresh: () => loadSession(set, get, true),

  primeFromLogin: login => {
    sessionRequest = null;
    setSessionToken(login.token);
    set({
      session: { token: login.token, user: login.user },
      error: null,
    });
  },
}));

onSessionInvalidated(() => useAuthStore.getState().clear());
