import { redirect } from 'react-router';

import { requireAdmin } from '../auth/require-admin';
import { getSessionToken } from '../auth/session';

// Where a page sends an operator it refuses: the one dashboard page every
// signed-in account can open.
const OPERATOR_LANDING = '/dashboard/services/api-keys';

// React Router runs matched loaders in parallel, so a child page cannot lean on
// the layout route's gate: without one of its own it would fire its API calls
// while that gate was still resolving. Every guarded page therefore asks for
// itself, and what is shared here is the spelling of the question and the
// address a refusal sends the operator to.
export const requireDashboardSession = (): void => {
  if (!getSessionToken()) throw redirect('/');
};

export const requireDashboardAdmin = async (): Promise<void> => {
  requireDashboardSession();
  if (!(await requireAdmin())) throw redirect(OPERATOR_LANDING);
};
