import { redirect } from 'react-router';

import type { Route } from './+types/dashboard-providers-upstreams-edit';
import { requireDashboardAdmin } from './guards';
import { revalidateOnPathnameChange } from './revalidation';
import { api, callApi } from '../api/client';
import { loadEditorAux, loadInitialModelCatalog } from '../components/upstream-editor/data';
import { UpstreamEditorPage } from '../components/upstream-editor/page';
import { dashboardWorkspaceHandle } from '../lib/dashboard-route-handle';

export const handle = dashboardWorkspaceHandle;

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  await requireDashboardAdmin();
  const [recordResult, aux] = await Promise.all([
    callApi(() => api.api.upstreams[':id'].$get({ param: { id: params.id } })),
    loadEditorAux(),
  ]);
  if (recordResult.error?.status === 404) {
    throw redirect('/dashboard/providers/upstreams?missing=1');
  }
  if (recordResult.error) throw new Error(recordResult.error.message);
  const catalog = await loadInitialModelCatalog(recordResult.data);
  return {
    ...aux,
    ...catalog,
    mode: 'edit' as const,
  };
}

export const shouldRevalidate = revalidateOnPathnameChange;

export default function DashboardProvidersUpstreamsEdit({ loaderData }: Route.ComponentProps) {
  return <UpstreamEditorPage data={loaderData} />;
}
