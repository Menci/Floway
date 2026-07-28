import { redirect } from 'react-router';

import type { Route } from './+types/dashboard-providers-upstreams-new';
import { callApi } from '../api/auth';
import { api } from '../api/client';
import type { UpstreamProviderKind, UpstreamRecord } from '../api/types';
import { getSessionToken } from '../auth/session';
import {
  loadEditorAux,
  providerDefaultName,
  providerKinds,
  requireAdmin,
} from '../components/upstream-editor/editor-data';
import { UpstreamEditorPage } from '../components/upstream-editor/upstream-editor-page';

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  if (!getSessionToken()) throw redirect('/');
  if (!(await requireAdmin())) throw redirect('/dashboard/services/api-keys');
  if (!providerKinds.includes(params.provider as UpstreamProviderKind)) {
    throw redirect('/dashboard/providers/upstreams');
  }

  const provider = params.provider as UpstreamProviderKind;
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
  return { ...aux, mode: 'create' as const, record, nextSortOrder };
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'New Upstream | Floway' }];
}

export default function DashboardProvidersUpstreamsNew({ loaderData }: Route.ComponentProps) {
  return <UpstreamEditorPage data={loaderData} />;
}
