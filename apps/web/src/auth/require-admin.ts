import { useAuthStore } from '../stores/auth-store';

// The admin gate, asked from a route loader. Loaders are this app's resource
// barrier: a page whose data is admin-only must be refused before that data is
// fetched, not after the component has mounted and read it.
export const requireAdmin = async (): Promise<boolean> =>
  (await useAuthStore.getState().initialize())?.isAdmin === true;
