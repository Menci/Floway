import { useLocalStorage } from '@vueuse/core';
import { defineStore } from 'pinia';
import { computed } from 'vue';

// We persist the full auth identity (key + isAdmin flag + the API key
// metadata returned by /auth/login for the non-admin path) so a refresh keeps
// the dashboard rendering the right view without a round trip.
export interface AuthIdentity {
  key: string;
  isAdmin: boolean;
  keyId?: string;
  keyName?: string;
  keyHint?: string;
}

const STORAGE_KEY = 'floway-auth';

export const useAuthStore = defineStore('auth', () => {
  const identity = useLocalStorage<AuthIdentity | null>(STORAGE_KEY, null, {
    serializer: {
      read: raw => {
        if (!raw) return null;
        try {
          return JSON.parse(raw) as AuthIdentity;
        } catch {
          return null;
        }
      },
      write: value => value === null ? '' : JSON.stringify(value),
    },
  });

  const isAuthenticated = computed(() => identity.value !== null);
  const isAdmin = computed(() => identity.value?.isAdmin === true);
  const authKey = computed(() => identity.value?.key ?? null);
  const apiKeyInfo = computed(() => {
    const v = identity.value;
    if (!v || v.isAdmin) return null;
    return { id: v.keyId, name: v.keyName, hint: v.keyHint };
  });

  const setAuth = (next: AuthIdentity) => {
    identity.value = next;
  };
  const clearAuth = () => {
    identity.value = null;
  };

  return { identity, isAuthenticated, isAdmin, authKey, apiKeyInfo, setAuth, clearAuth };
});
