import { create } from 'zustand';

import { type AuthUser, type LoginResponse } from '../api/auth';
import { getCurrentSession, api } from '../api/client';
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
  primeFromLogin: (session: LoginResponse) => void;
  primeFromSession: (user: AuthUser, token: string) => void;
  setUser: (user: AuthUser) => void;
}

let sessionRequest: {
  token: string;
  promise: Promise<AuthUser | null>;
} | null = null;

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

  // Local logout intent takes precedence when server-side revocation fails;
  // the gateway will expire any surviving session independently.
  logout: async () => {
    try {
      await api.auth.logout.$post();
    } finally {
      get().clear();
    }
  },

  initialize: () => {
    const token = getSessionToken();
    if (!token) {
      get().clear();
      return Promise.resolve(null);
    }

    const state = get();
    if (
      state.status === 'authenticated' &&
      state.token === token &&
      state.user
    ) {
      return Promise.resolve(state.user);
    }

    if (sessionRequest?.token === token) return sessionRequest.promise;

    set({
      status: 'loading',
      token,
      user: state.token === token ? state.user : null,
      error: null,
    });

    const promise = getCurrentSession().then(result => {
      if (sessionRequest?.token === token) sessionRequest = null;

      if (result.data) {
        set({
          status: 'authenticated',
          token,
          user: result.data.user,
          error: null,
        });
        return result.data.user;
      }

      if (result.error.status === 401) {
        get().clear();
        return null;
      }

      set({
        status: 'error',
        token,
        user: null,
        error: result.error.message,
      });
      return null;
    });

    sessionRequest = { token, promise };
    return promise;
  },

  primeFromLogin: session => {
    sessionRequest = null;
    set({
      status: 'authenticated',
      token: session.token,
      user: session.user,
      error: null,
    });
  },

  primeFromSession: (user, token) => {
    sessionRequest = null;
    set({
      status: 'authenticated',
      token,
      user,
      error: null,
    });
  },

  setUser: user => {
    set({ status: 'authenticated', user, error: null });
  },
}));

onSessionInvalidated(() => useAuthStore.getState().clear());
