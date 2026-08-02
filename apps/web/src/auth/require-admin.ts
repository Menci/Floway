import { useAuthStore } from '../stores/auth-store';

// Loaders are this app's resource barrier: admin-only data must be refused
// before it is fetched, not after the component has mounted and read it.
export const requireAdmin = async (): Promise<boolean> =>
  (await useAuthStore.getState().initialize())?.isAdmin === true;
