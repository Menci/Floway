import type { ShouldRevalidateFunctionArgs } from 'react-router';

import type { Route } from './+types/dashboard-admin-permissions';
import { requireDashboardPermissions } from './guards';
import { loadPermissionsData, unloadedPermissionsData } from '../components/access-control/data';
import { PermissionsWorkspace } from '../components/access-control/workspace';

export async function clientLoader() {
  const user = await requireDashboardPermissions();
  return { ...await loadPermissionsData(unloadedPermissionsData), admin: user.isAdmin };
}

export const shouldRevalidate = ({ currentUrl, nextUrl, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) =>
  currentUrl.pathname !== nextUrl.pathname && defaultShouldRevalidate;

export default function DashboardAdminPermissions({ loaderData }: Route.ComponentProps) {
  return <PermissionsWorkspace admin={loaderData.admin} initial={loaderData} />;
}
