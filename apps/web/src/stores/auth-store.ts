import { create } from 'zustand';
import type { StoreApi } from 'zustand';

import { getCurrentSession, type AuthUser, type LoginResponse } from '../api/auth';
import { api } from '../api/client';
import { clearSessionToken, getSessionToken, onSessionInvalidated } from '../auth/session';

type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'unauthenticated' | 'error';

interface AuthStore {
  status: AuthStatus;
  token: string | null;
  user: AuthUser | null;
  error: string | null;
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
  if (!force && state.status === 'authenticated' && state.token === token && state.user) {
    return Promise.resolve(state.user);
  }
  if (sessionRequest?.token === token) return sessionRequest.promise;

  set({ status: 'loading', token, user: state.token === token ? state.user : null, error: null });
  const requestId = {};
  const promise = getCurrentSession().then(result => {
    if (sessionRequest?.id !== requestId || getSessionToken() !== token) {
      const current = get();
      return current.token === getSessionToken() ? current.user : null;
    }
    sessionRequest = null;
    if (result.data) {
      set({ status: 'authenticated', token, user: result.data.user, error: null });
      return result.data.user;
    }
    if (result.error.status === 401) {
      get().clear();
      return null;
    }
    const current = get();
    const user = current.token === token ? current.user : null;
    set({ status: user ? 'authenticated' : 'error', token, user, error: result.error.message });
    return null;
  });
  sessionRequest = { id: requestId, token, promise };
  return promise;
};

export const useAuthStore = create<AuthStore>((set, get) => ({
  status: 'idle',
  token: null,
  user: null,
  error: null,

  clear: () => {
    sessionRequest = null;
    clearSessionToken();
    set({
      status: 'unauthenticated',
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
      status: 'authenticated',
      token: session.token,
      user: session.user,
      error: null,
    });
  },
}));

onSessionInvalidated(() => useAuthStore.getState().clear());
