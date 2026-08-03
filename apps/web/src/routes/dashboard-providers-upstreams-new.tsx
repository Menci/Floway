import { redirect } from 'react-router';

import type { Route } from './+types/dashboard-providers-upstreams-new';
import { requireDashboardAdmin } from './guards';
import { revalidateOnPathnameChange } from './revalidation';
import { api, callApi } from '../api/client';
import {
  loadEditorAux,
  providerDefaultName,
} from '../components/upstream-editor/data';
import { UpstreamEditorPage } from '../components/upstream-editor/page';
import { dashboardWorkspaceHandle } from '../lib/dashboard-route-handle';
import { pickDistinctHue } from '../lib/hue';
import { ALL_PROVIDER_KINDS } from '@floway-dev/provider';

export const handle = dashboardWorkspaceHandle;

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  await requireDashboardAdmin();
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
    // A blueprint carries no hue: the badge only has to be told apart from the
    // ones already on screen, which is a fact the dashboard holds and the
    // server does not.
    hue: pickDistinctHue(aux.upstreams.map(upstream => upstream.hue)),
  };
  return { ...aux, mode: 'create' as const, record, discovered: [], modelsError: null };
}

export const shouldRevalidate = revalidateOnPathnameChange;

export default function DashboardProvidersUpstreamsNew({ loaderData }: Route.ComponentProps) {
  return <UpstreamEditorPage data={loaderData} />;
}
