import { useLocalStorage } from '@vueuse/core';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

export interface AuthUser {
  id: number;
  username: string;
  isAdmin: boolean;
  upstreamIds: string[] | null;
}

// Only the session token is persisted. Everything else (admin flag, upstream
// cap) is server-authoritative and must be re-fetched from /auth/me on every
// app boot — caching it in localStorage lets stale permissions linger after an
// admin promotes/demotes the actor or rotates their upstream cap.
export const useAuthStore = defineStore('auth', () => {
  const token = useLocalStorage<string | null>('floway-token', null);
  const user = ref<AuthUser | null>(null);

  const isAuthenticated = computed(() => token.value !== null && user.value !== null);
  const isAdmin = computed(() => user.value?.isAdmin === true);
  const currentUser = computed(() => user.value);
  const authToken = computed(() => token.value);

  const setAuth = (next: { token: string; user: AuthUser }) => {
    token.value = next.token;
    user.value = next.user;
  };
  const setUser = (next: AuthUser) => {
    if (token.value === null) throw new Error('setUser called without an authenticated session');
    user.value = next;
  };
  const clearAuth = () => {
    token.value = null;
    user.value = null;
  };

  return {
    isAuthenticated,
    isAdmin,
    authToken,
    currentUser,
    setAuth,
    setUser,
    clearAuth,
  };
});
