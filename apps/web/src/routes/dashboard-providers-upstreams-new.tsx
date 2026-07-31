import { redirect } from 'react-router';

import type { Route } from './+types/dashboard-providers-upstreams-new';
import { callApi } from '../api/auth';
import { api } from '../api/client';
import { requireAdmin } from '../auth/require-admin';
import { getSessionToken } from '../auth/session';
import {
  loadEditorAux,
  providerDefaultName,
} from '../components/upstream-editor/editor-data';
import { UpstreamEditorPage } from '../components/upstream-editor/upstream-editor-page';
import { dashboardWorkspaceHandle } from '../lib/dashboard-route-handle';
import { ALL_PROVIDER_KINDS } from '@floway-dev/provider';

export const handle = dashboardWorkspaceHandle;

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  if (!getSessionToken()) throw redirect('/');
  if (!(await requireAdmin())) throw redirect('/dashboard/services/api-keys');
  const kind = ALL_PROVIDER_KINDS.find(candidate => candidate === params.provider);
  if (!kind) {
    throw redirect('/dashboard/providers/upstreams');
  }
  const [recordResult, aux] = await Promise.all([
    callApi(() =>
      api.api.upstreams.blueprint.$get({ query: { kind } })),
    loadEditorAux(),
  ]);
  if (recordResult.error) throw new Error(recordResult.error.message);
  const record = {
    ...recordResult.data,
    name: providerDefaultName[kind],
    enabled: true,
  };
  return { ...aux, mode: 'create' as const, record, discovered: [], modelsError: null };
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'New Upstream | Floway' }];
}

export default function DashboardProvidersUpstreamsNew({ loaderData }: Route.ComponentProps) {
  return <UpstreamEditorPage data={loaderData} />;
}
