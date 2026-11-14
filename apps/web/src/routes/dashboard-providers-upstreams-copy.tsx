import { redirect } from 'react-router';

import type { Route } from './+types/dashboard-providers-upstreams-copy';
import { requireDashboardAdmin } from './guards';
import { revalidateOnPathnameChange } from './revalidation';
import { api, callApi } from '../api/client';
import type { UpstreamRecord } from '../api/types';
import { loadEditorAux } from '../components/upstream-editor/data';
import { UpstreamEditorPage } from '../components/upstream-editor/page';
import { i18n } from '../i18n';
import { dashboardWorkspaceHandle } from '../lib/dashboard-route-handle';
import { pickDistinctHue } from '../lib/hue';

export const handle = dashboardWorkspaceHandle;

// API-key credentials copy with the rest of the config and stay editable on
// the copy; OAuth credentials are deliberately reset to the provider's
// blueprint shape, because those tokens are minted by the OAuth exchange and
// may not be valid as a second grant.
const copyableRecord = (source: UpstreamRecord, name: string, hue: number): UpstreamRecord => {
  const base = {
    id: '',
    name,
    enabled: true,
    usage_refresh_interval_minutes: 0,
    sort_order: 0,
    created_at: '',
    updated_at: '',
    flag_overrides: structuredClone(source.flag_overrides),
    flag_defaults: structuredClone(source.flag_defaults),
    disabled_public_model_ids: [...source.disabled_public_model_ids],
    proxy_fallback_list: structuredClone(source.proxy_fallback_list),
    model_prefix: source.model_prefix === null ? null : structuredClone(source.model_prefix),
    hue,
    modelsCache: { fetchedAt: null, lastError: null, modelCount: null },
  };

  switch (source.kind) {
  case 'custom':
    return { ...base, kind: 'custom', config: structuredClone(source.config), state: null };
  case 'azure':
    return { ...base, kind: 'azure', config: structuredClone(source.config), state: null };
  case 'ollama':
    return { ...base, kind: 'ollama', config: structuredClone(source.config), state: null };
  case 'copilot':
    return {
      ...base,
      kind: 'copilot',
      config: {
        githubHost: source.config.githubHost,
        githubToken: '',
        user: { login: '', avatar_url: '', name: null, id: 0 },
      },
      state: null,
    };
  case 'codex':
    return { ...base, kind: 'codex', config: { accounts: [] }, state: { accounts: [] } };
  case 'claude-code':
    return { ...base, kind: 'claude-code', config: { accounts: [] }, state: { accounts: [] } };
  }
};

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  await requireDashboardAdmin();
  const [sourceResult, aux, upstreamsResult] = await Promise.all([
    callApi(() => api.api.upstreams[':id'].$get({ param: { id: params.id } })),
    loadEditorAux(),
    callApi(() => api.api.upstreams.$get()),
  ]);
  if (sourceResult.error?.status === 404) {
    throw redirect('/dashboard/providers/upstreams?missing=1');
  }
  if (sourceResult.error) throw new Error(sourceResult.error.message);
  if (upstreamsResult.error) throw new Error(upstreamsResult.error.message);
  const source = sourceResult.data;
  const record = copyableRecord(
    source,
    i18n.t('dashboard.upstreams.copy.nameSuffix', { name: source.name }),
    pickDistinctHue(upstreamsResult.data.map(upstream => upstream.hue)),
  );
  return {
    ...aux,
    editLevel: 'full' as const,
    mode: 'create' as const,
    record,
    discovered: null,
  };
}

export const shouldRevalidate = revalidateOnPathnameChange;

export default function DashboardProvidersUpstreamsCopy({ loaderData }: Route.ComponentProps) {
  return <UpstreamEditorPage data={loaderData} />;
}
