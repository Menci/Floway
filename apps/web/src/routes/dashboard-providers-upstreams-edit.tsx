import { redirect } from 'react-router';

import type { Route } from './+types/dashboard-providers-upstreams-edit';
import { requireDashboardUser } from './guards';
import { revalidateOnPathnameChange } from './revalidation';
import { api, callApi } from '../api/client';
import { loadEditorAux } from '../components/upstream-editor/data';
import { UpstreamEditorPage } from '../components/upstream-editor/page';
import { dashboardWorkspaceHandle } from '../lib/dashboard-route-handle';

export const handle = dashboardWorkspaceHandle;

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  await requireDashboardUser();
  const recordResult = await callApi(() => api.api.upstreams[':id'].$get({ param: { id: params.id } }));
  if (recordResult.error?.status === 404) {
    throw redirect('/dashboard/providers/upstreams?missing=1');
  }
  if (recordResult.error) throw new Error(recordResult.error.message);
  if (recordResult.data.editLevel === 'off' && !recordResult.data.audit) throw redirect('/dashboard/providers/upstreams');
  const aux = await loadEditorAux(params.id);
  return {
    ...aux,
    audit: recordResult.data.audit,
    editLevel: recordResult.data.editLevel,
    record: recordResult.data,
    discovered: recordResult.data.cachedModels,
    mode: 'edit' as const,
  };
}

export const shouldRevalidate = revalidateOnPathnameChange;

export default function DashboardProvidersUpstreamsEdit({ loaderData }: Route.ComponentProps) {
  return <UpstreamEditorPage data={loaderData} />;
}
