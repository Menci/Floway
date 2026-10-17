import type { ShouldRevalidateFunctionArgs } from 'react-router';

import type { Route } from './+types/dashboard-admin-permissions';
import { requireDashboardAdmin } from './guards';
import { loadPermissionsData, unloadedPermissionsData } from '../components/access-control/data';
import { PermissionsWorkspace } from '../components/access-control/workspace';

export async function clientLoader() {
  await requireDashboardAdmin();
  return await loadPermissionsData(unloadedPermissionsData);
}

export const shouldRevalidate = ({ currentUrl, nextUrl, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) =>
  currentUrl.pathname !== nextUrl.pathname && defaultShouldRevalidate;

export default function DashboardAdminPermissions({ loaderData }: Route.ComponentProps) {
  return <PermissionsWorkspace initial={loaderData} />;
}
