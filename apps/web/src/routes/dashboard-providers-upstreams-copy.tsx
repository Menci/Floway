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

// A copy opens the create editor seeded from the source record. API-key
// credentials are carried over with the editor's usual "leave blank to keep"
// contract; OAuth credentials are deliberately reset to the provider's
// blueprint shape, because those tokens are minted by the OAuth exchange and
// may not be valid as a second grant.
const copyableRecord = (source: UpstreamRecord, name: string, hue: number): {
  record: UpstreamRecord;
  preserveCredentials: boolean;
} => {
  const base = {
    id: '',
    name,
    enabled: true,
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
    return {
      record: { ...base, kind: 'custom', config: structuredClone(source.config), state: null },
      preserveCredentials: source.config.authStyle !== 'none',
    };
  case 'azure':
    return {
      record: { ...base, kind: 'azure', config: structuredClone(source.config), state: null },
      preserveCredentials: true,
    };
  case 'ollama':
    return {
      record: { ...base, kind: 'ollama', config: structuredClone(source.config), state: null },
      preserveCredentials: true,
    };
  case 'copilot':
    return {
      record: {
        ...base,
        kind: 'copilot',
        config: {
          githubHost: source.config.githubHost,
          githubToken: '',
          user: { login: '', avatar_url: '', name: null, id: 0 },
        },
        state: null,
      },
      preserveCredentials: false,
    };
  case 'codex':
    return {
      record: { ...base, kind: 'codex', config: { accounts: [] }, state: { accounts: [] } },
      preserveCredentials: false,
    };
  case 'claude-code':
    return {
      record: { ...base, kind: 'claude-code', config: { accounts: [] }, state: { accounts: [] } },
      preserveCredentials: false,
    };
  }
};

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  await requireDashboardAdmin();
  const [sourceResult, aux] = await Promise.all([
    callApi(() => api.api.upstreams[':id'].$get({ param: { id: params.id } })),
    loadEditorAux(),
  ]);
  if (sourceResult.error?.status === 404) {
    throw redirect('/dashboard/providers/upstreams?missing=1');
  }
  if (sourceResult.error) throw new Error(sourceResult.error.message);
  const source = sourceResult.data;
  const { record, preserveCredentials } = copyableRecord(
    source,
    i18n.t('dashboard.upstreams.copy.nameSuffix', { name: source.name }),
    pickDistinctHue(aux.upstreams.map(upstream => upstream.hue)),
  );
  return {
    ...aux,
    mode: 'create' as const,
    record,
    discovered: [],
    modelsError: null,
    preserveCredentials,
  };
}

export const shouldRevalidate = revalidateOnPathnameChange;

export default function DashboardProvidersUpstreamsCopy({ loaderData }: Route.ComponentProps) {
  return <UpstreamEditorPage data={loaderData} />;
}
