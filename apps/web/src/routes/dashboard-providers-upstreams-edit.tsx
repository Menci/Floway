import { useEffect } from 'react';
import { redirect, useLocation, useNavigate } from 'react-router';

import type { Route } from './+types/dashboard-providers-upstreams-edit';
import { requireDashboardAdmin } from './guards';
import { revalidateOnPathnameChange } from './revalidation';
import { api, callApi } from '../api/client';
import { CATALOG_HANDOFF_QUERY, consumeCatalogHandoff } from '../components/upstream-editor/catalog-handoff';
import { loadEditorAux, loadInitialModelCatalog } from '../components/upstream-editor/data';
import { UpstreamEditorPage } from '../components/upstream-editor/page';
import { dashboardWorkspaceHandle } from '../lib/dashboard-route-handle';
import { useEntryRewrite } from '../lib/page-navigation';

export const handle = dashboardWorkspaceHandle;

export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  await requireDashboardAdmin();
  const [recordResult, aux] = await Promise.all([
    callApi(() => api.api.upstreams[':id'].$get({ param: { id: params.id } })),
    loadEditorAux(),
  ]);
  if (recordResult.error?.status === 404) {
    throw redirect('/dashboard/providers/upstreams?missing=1');
  }
  if (recordResult.error) throw new Error(recordResult.error.message);
  const token = new URL(request.url).searchParams.get(CATALOG_HANDOFF_QUERY);
  const handoff = token === null ? null : consumeCatalogHandoff(token, recordResult.data.id, recordResult.data.configVersion);
  const catalog = handoff === null ? await loadInitialModelCatalog(recordResult.data) : {
    record: recordResult.data,
    discovered: handoff.discovered ?? [],
    modelsError: handoff.modelsError,
  };
  return {
    ...aux,
    ...catalog,
    mode: 'edit' as const,
  };
}

export const shouldRevalidate = revalidateOnPathnameChange;

export default function DashboardProvidersUpstreamsEdit({ loaderData }: Route.ComponentProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const rewrite = useEntryRewrite();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has(CATALOG_HANDOFF_QUERY)) return;
    params.delete(CATALOG_HANDOFF_QUERY);
    void navigate({ pathname: location.pathname, search: params.toString() }, rewrite);
  }, [location.pathname, location.search, navigate, rewrite]);
  return <UpstreamEditorPage data={loaderData} />;
}
