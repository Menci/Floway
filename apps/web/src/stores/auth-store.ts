import { create } from 'zustand';
import type { StoreApi } from 'zustand';

import { getCurrentSession, type AuthUser, type LoginResponse } from '../api/auth';
import { api, type GlobalError } from '../api/client';
import { clearSessionToken, getSessionToken, onSessionInvalidated } from '../auth/session';

interface AuthStore {
  token: string | null;
  user: AuthUser | null;
  error: GlobalError | null;
  clear: () => void;
  logout: () => Promise<void>;
  initialize: () => Promise<AuthUser | null>;
  refresh: () => Promise<AuthUser | null>;
  primeFromLogin: (session: LoginResponse) => void;
}

let sessionRequest: {
  id: object;
  token: string;
  promise: Promise<AuthUser | null>;
} | null = null;

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

  const state = get();
  // The in-flight check comes first: a pending request keeps the previous user
  // in place when the token is unchanged, so the cached-session fast path below
  // would otherwise resolve a caller from an identity the request may replace.
  if (sessionRequest?.token === token) return sessionRequest.promise;
  if (!force && state.token === token && state.user) {
    return Promise.resolve(state.user);
  }

  set({ token, user: state.token === token ? state.user : null, error: null });
  const requestId = {};
  const promise = getCurrentSession().then(result => {
    if (sessionRequest?.id !== requestId || getSessionToken() !== token) {
      const current = get();
      return current.token === getSessionToken() ? current.user : null;
    }
    sessionRequest = null;
    if (result.data) {
      set({ token, user: result.data.user, error: null });
      return result.data.user;
    }
    if (result.error.status === 401) {
      get().clear();
      return null;
    }
    const current = get();
    set({ token, user: current.token === token ? current.user : null, error: result.error });
    return null;
  });
  sessionRequest = { id: requestId, token, promise };
  return promise;
};

export const useAuthStore = create<AuthStore>((set, get) => ({
  token: null,
  user: null,
  error: null,

  clear: () => {
    sessionRequest = null;
    clearSessionToken();
    set({
      token: null,
      user: null,
      error: null,
    });
  },

  // Local logout intent takes precedence when server-side revocation fails; the
  // gateway expires any surviving session independently. A bare `finally`
  // re-raises the rejection past the clear.
  logout: async () => {
    try {
      await api.auth.logout.$post();
    } catch (error) {
      console.warn('Revoking the session upstream failed; signing out locally anyway.', error);
    } finally {
      get().clear();
    }
  },

  initialize: () => loadSession(set, get, false),
  refresh: () => loadSession(set, get, true),

  primeFromLogin: session => {
    sessionRequest = null;
    set({
      token: session.token,
      user: session.user,
      error: null,
    });
  },
}));

onSessionInvalidated(() => useAuthStore.getState().clear());
