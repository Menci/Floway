import { useAuthStore } from '../stores/auth-store';

export const requireAdmin = async (): Promise<boolean> =>
  (await useAuthStore.getState().initialize())?.isAdmin === true;
