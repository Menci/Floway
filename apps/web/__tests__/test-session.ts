import { useAuthStore } from '../src/stores/auth-store';

// Components that read the signed-in account's preferences need a session to
// read. A suite that exercises the session itself leaves this alone.
export const primeDefaultSession = (): void => {
  useAuthStore.getState().primeFromLogin({
    token: 'test-session',
    user: {
      id: 1,
      username: 'admin',
      isAdmin: true,
      canViewPermissions: true,
      canViewUpstreams: true,
      preferences: { quotaDisplay: 'remaining', language: null },
    },
  });
};
