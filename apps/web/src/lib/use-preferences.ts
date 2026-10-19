import { useAuthStore } from '../stores/auth-store';
import type { UserPreferences } from '@floway-dev/protocols/browser';

// Preferences are part of the session the server returned, so every surface
// reads the value that was last accepted rather than a copy that could drift.
export const useUserPreferences = (): UserPreferences => {
  const preferences = useAuthStore(state => state.session?.user.preferences ?? null);
  if (preferences === null) throw new Error('Preferences are read without a signed-in session');
  return preferences;
};
