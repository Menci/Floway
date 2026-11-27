import { updateOwnPreferences } from '../api/auth';
import { useAuthStore } from '../stores/auth-store';
import type { UserPreferences } from '@floway-dev/protocols/browser';

// Preferences are part of the session the server returned, so every surface
// reads the value that was last accepted rather than a copy that could drift.
export const useUserPreferences = (): UserPreferences => {
  const preferences = useAuthStore(state => state.session?.user.preferences ?? null);
  if (preferences === null) throw new Error('Preferences are read without a signed-in session');
  return preferences;
};

// Serializes background preference patches so rapid toggles cannot race on the
// server's read-modify-write, while applying the choice optimistically and
// leaving it in place if the network write fails.
let writeSequence = 0;
let writeQueue: Promise<void> = Promise.resolve();

export const savePreferenceInBackground = (
  patch: Partial<UserPreferences>,
  onError: (message: string) => void,
): void => {
  const session = useAuthStore.getState().session;
  if (session === null) throw new Error('Preferences are saved without a signed-in session');
  const token = session.token;
  useAuthStore.getState().replacePreferences({ ...session.user.preferences, ...patch });
  const sequence = ++writeSequence;
  writeQueue = writeQueue.then(async () => {
    const result = await updateOwnPreferences(patch);
    const latest = useAuthStore.getState().session;
    if (latest?.token !== token) return;
    if (result.error) {
      onError(result.error.message);
      return;
    }
    if (sequence === writeSequence) {
      const confirmed = Object.fromEntries(
        (Object.keys(patch) as Array<keyof UserPreferences>)
          .filter(key => patch[key] !== undefined)
          .map(key => [key, result.data.preferences[key]]),
      ) as Partial<UserPreferences>;
      useAuthStore.getState().replacePreferences({ ...latest.user.preferences, ...confirmed });
    }
  });
};
