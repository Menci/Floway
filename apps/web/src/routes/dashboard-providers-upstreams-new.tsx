import { redirect } from 'react-router';

import type { Route } from './+types/dashboard-providers-upstreams-new';
import { callApi } from '../api/auth';
import { api } from '../api/client';
import type { UpstreamProviderKind } from '../api/types';
import { getSessionToken } from '../auth/session';
import {
  loadEditorAux,
  providerDefaultName,
  requireAdmin,
} from '../components/upstream-editor/editor-data';
import { UpstreamEditorPage } from '../components/upstream-editor/upstream-editor-page';
import { dashboardWorkspaceHandle } from '../lib/dashboard-route-handle';
import { ALL_PROVIDER_KINDS } from '@floway-dev/provider';

export const handle = dashboardWorkspaceHandle;

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  if (!getSessionToken()) throw redirect('/');
  if (!(await requireAdmin())) throw redirect('/dashboard/services/api-keys');
  const provider = ALL_PROVIDER_KINDS.find(kind => kind === params.provider);
  if (!provider) {
    throw redirect('/dashboard/providers/upstreams');
  }
  const [recordResult, aux] = await Promise.all([
    callApi(() =>
      api.api.upstreams.blueprint.$get({ query: { kind: provider } })),
    loadEditorAux(),
  ]);
  if (recordResult.error) throw new Error(recordResult.error.message);
  const record = {
    ...recordResult.data,
    name: providerDefaultName[provider],
    enabled: true,
  };
  const nextSortOrder = aux.upstreams.reduce(
    (max, item) => Math.max(max, item.sort_order),
    -1,
  ) + 1;
  return { ...aux, mode: 'create' as const, record, nextSortOrder, discovered: [], modelsError: null };
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'New Upstream | Floway' }];
}

export default function DashboardProvidersUpstreamsNew({ loaderData }: Route.ComponentProps) {
  return <UpstreamEditorPage data={loaderData} />;
}
