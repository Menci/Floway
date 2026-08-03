import { redirect } from 'react-router';

import type { AuthUser } from '../api/auth';
import { requireAdmin } from '../auth/require-admin';
import { getSessionToken } from '../auth/session';
import { useAuthStore } from '../stores/auth-store';

// The one dashboard page every signed-in account can open.
const OPERATOR_LANDING = '/dashboard/services/api-keys';

// React Router runs matched loaders in parallel, so a child page's own gate is
// not redundant with the layout route's.
export const requireDashboardSession = (): void => {
  if (!getSessionToken()) throw redirect('/');
};

// For a loader that reads the account itself -- which view it may ask for, what
// it may group by. The layout route resolves the same session in parallel and
// puts it in the outlet context, so a component takes the user from there
// rather than from its own loader.
export const requireDashboardUser = async (): Promise<AuthUser> => {
  requireDashboardSession();
  const user = await useAuthStore.getState().initialize();
  if (!user) throw redirect('/');
  return user;
};

export const requireDashboardAdmin = async (): Promise<void> => {
  requireDashboardSession();
  if (!(await requireAdmin())) throw redirect(OPERATOR_LANDING);
};
