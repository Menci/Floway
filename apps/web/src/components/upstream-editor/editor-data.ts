
import type { InferRequestType } from 'hono/client';

import { callApi } from '../../api/auth';
import { api, getCurrentSession } from '../../api/client';
import { upstreamRecordsFromWire } from '../../api/types';
import type {
  BackoffRow,
  CustomRawModel,
  ModelEndpoints,
  ProxyRecord,
  UpstreamModelConfig,
  UpstreamProviderKind,
  UpstreamRecord,
  UpstreamRecordEnvelope,
} from '../../api/types';
import type { Flag } from '@floway-dev/provider/flags';

type CreateUpstreamBody = InferRequestType<typeof api.api.upstreams.$post>['json'];
type UpdateUpstreamBody = InferRequestType<typeof api.api.upstreams[':id']['$patch']>['json'];

export interface RuntimeInfo {
  kind: 'node' | 'cloudflare';
  runtimeLocation: string;
}

export interface EditorAuxData {
  flags: Flag[];
  proxies: ProxyRecord[];
  backoffs: BackoffRow[];
  runtime: RuntimeInfo;
  upstreams: UpstreamRecord[];
}

export interface UpstreamEditorLoaderData extends EditorAuxData {
  mode: 'create' | 'edit';
  record: UpstreamRecord;
  nextSortOrder: number;
}

export interface UpstreamEditorValues {
  name: string;
  enabled: boolean;
  color: UpstreamRecord['color'];
  proxyFallbackList: UpstreamRecord['proxy_fallback_list'];
  modelPrefix: UpstreamRecord['model_prefix'];
  disabledPublicModelIds: string[];
  flagOverrides: UpstreamRecord['flag_overrides'];
  config: UpstreamRecord['config'];
  state: UpstreamRecord['state'];
  manualModels: UpstreamModelConfig[];
}

export const providerKinds: readonly UpstreamProviderKind[] = [
  'custom', 'azure', 'copilot', 'codex', 'claude-code', 'ollama',
];

export const providerDefaultName: Record<UpstreamProviderKind, string> = {
  custom: 'Custom upstream',
  azure: 'Azure AI',
  copilot: 'GitHub Copilot',
  codex: 'ChatGPT Codex',
  'claude-code': 'Claude Code',
  ollama: 'Ollama',
};

export async function requireAdmin() {
  const session = await getCurrentSession();
  return !session.error && session.data.user.isAdmin;
}

export async function loadEditorAux(): Promise<EditorAuxData> {
  const [flags, proxies, backoffs, runtime, upstreams] = await Promise.all([
    callApi(() => api.api.upstreams.flags.$get()),
    callApi(() => api.api.proxies.$get()),
    callApi(() => api.api.proxies.backoffs.$get()),
    callApi(() => api.api['runtime-info'].$get()),
    callApi(() => api.api.upstreams.$get()),
  ]);
  const error = flags.error ?? proxies.error ?? backoffs.error ?? runtime.error ?? upstreams.error;
  if (error) throw new Error(error.message);
  return {
    flags: [...flags.data!],
    proxies: proxies.data!,
    backoffs: backoffs.data!,
    runtime: runtime.data!,
    upstreams: upstreamRecordsFromWire(upstreams.data!),
  };
}

export function valuesFromRecord(record: UpstreamRecord): UpstreamEditorValues {
  const config: UpstreamRecord['config'] = record.kind === 'custom'
    ? {
        ...structuredClone(record.config),
        apiKey: '',
        ...(record.id === '' && Object.keys(record.config.endpoints).length === 0
          ? { endpoints: { chatCompletions: {} }, modelsFetch: { ...record.config.modelsFetch, enabled: true } }
          : {}),
      }
    : record.kind === 'azure'
      ? { ...structuredClone(record.config), apiKey: '' }
      : record.kind === 'ollama'
        ? { ...structuredClone(record.config), apiKey: '' }
        : structuredClone(record.config);
  const manualModels = record.kind === 'custom' || record.kind === 'azure' || record.kind === 'ollama'
    ? structuredClone(record.config.models).map(model => model.flagOverrides
        ? { ...model }
        : model)
    : [];
  return {
    name: record.name,
    enabled: record.enabled,
    color: record.color,
    proxyFallbackList: structuredClone(record.proxy_fallback_list),
    modelPrefix: structuredClone(record.model_prefix),
    disabledPublicModelIds: [...record.disabled_public_model_ids],
    flagOverrides: record.flag_overrides,
    config,
    state: structuredClone(record.state),
    manualModels,
  };
}

// The editor holds one flat form model for every provider kind, so the config
// is assembled structurally and only becomes a specific union member here.
// This is the single point where the two representations meet.
export function configFromValues(
  record: UpstreamRecord,
  values: UpstreamEditorValues,
  options: { preserveStoredSecret?: boolean } = {},
): UpstreamRecord['config'] {
  const config = structuredClone(values.config) as unknown as Record<string, unknown>;
  if (record.kind === 'custom' || record.kind === 'azure' || record.kind === 'ollama') {
    config.models = structuredClone(values.manualModels);
    const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
    if (apiKey) config.apiKey = apiKey;
    else if (options.preserveStoredSecret && 'apiKey' in record.config && record.config.apiKey) {
      config.apiKey = record.config.apiKey;
    } else delete config.apiKey;
  }
  if (record.kind === 'custom') {
    const custom = config as Record<string, unknown>;
    if (custom.authStyle === 'none') delete custom.apiKey;
    if (custom.pathOverrides && typeof custom.pathOverrides === 'object') {
      const entries = Object.entries(custom.pathOverrides as Record<string, string>)
        .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : ''] as const)
        .filter(([, value]) => value.length > 0);
      if (entries.length) custom.pathOverrides = Object.fromEntries(entries);
      else delete custom.pathOverrides;
    }
  }
  return config as unknown as UpstreamRecord['config'];
}

export function previewRecord(record: UpstreamRecord, values: UpstreamEditorValues): UpstreamRecordEnvelope {
  return {
    ...record,
    name: values.name.trim(),
    enabled: values.enabled,
    color: values.color,
    config: configFromValues(record, values, { preserveStoredSecret: true }),
    state: values.state,
    proxy_fallback_list: values.proxyFallbackList,
    model_prefix: values.modelPrefix,
    disabled_public_model_ids: values.disabledPublicModelIds,
    flag_overrides: values.flagOverrides,
  };
}

export function createBody(record: UpstreamRecord, values: UpstreamEditorValues, sortOrder: number): CreateUpstreamBody {
  return {
    kind: record.kind,
    name: values.name.trim(),
    enabled: values.enabled,
    color: values.color,
    sort_order: sortOrder,
    flag_overrides: values.flagOverrides,
    disabled_public_model_ids: values.disabledPublicModelIds,
    proxy_fallback_list: values.proxyFallbackList,
    model_prefix: values.modelPrefix,
    config: configFromValues(record, values),
    ...((record.kind === 'copilot' || record.kind === 'codex' || record.kind === 'claude-code')
      ? { state: values.state }
      : {}),
    // The editor's form model is flat across provider kinds while the wire
    // contract discriminates on `kind`; TypeScript cannot prove the two agree
    // from a structurally assembled object. Field names, method and path stay
    // checked against the route — only this correlation is asserted.
  } as CreateUpstreamBody;
}

export function updateBody(record: UpstreamRecord, values: UpstreamEditorValues): UpdateUpstreamBody {
  return {
    name: values.name.trim(),
    enabled: values.enabled,
    color: values.color,
    flag_overrides: values.flagOverrides,
    disabled_public_model_ids: values.disabledPublicModelIds,
    proxy_fallback_list: values.proxyFallbackList,
    model_prefix: values.modelPrefix,
    ...((record.kind === 'custom' || record.kind === 'azure' || record.kind === 'ollama')
      ? { config: configFromValues(record, values) }
      : {}),
  } as UpdateUpstreamBody;
}

const discoveredCustomModelEndpoints = (
  kind: CustomRawModel['kind'],
  configured: ModelEndpoints,
): ModelEndpoints => {
  if (kind === 'embedding') return { embeddings: {} };
  if (kind === 'image') return { imagesGenerations: {}, imagesEdits: {} };
  if (kind === 'transcription') return { audioTranscriptions: {} };
  if (kind === 'rerank') return {};
  return Object.keys(configured).length ? structuredClone(configured) : { chatCompletions: {} };
};

export function discoveredModelsFromResponse(
  kind: UpstreamProviderKind,
  data: UpstreamModelConfig[] | CustomRawModel[],
  endpoints: ModelEndpoints,
): UpstreamModelConfig[] {
  if (kind !== 'custom') return data as UpstreamModelConfig[];
  return (data as CustomRawModel[]).map(model => {
    const modelEndpoints = discoveredCustomModelEndpoints(model.kind, endpoints);
    return {
      upstreamModelId: model.id,
      publicModelId: model.id,
      kind: model.kind ?? 'chat',
      endpoints: modelEndpoints,
      ...(model.display_name ?? model.name ? { display_name: model.display_name ?? model.name } : {}),
      ...(model.limits ? { limits: model.limits } : {}),
      ...(model.pricing ? { pricing: model.pricing } : {}),
    };
  });
}

export const publicModelId = (model: UpstreamModelConfig) => {
  const publicId = typeof model.publicModelId === 'string' ? model.publicModelId.trim() : '';
  if (publicId) return publicId;
  return typeof model.upstreamModelId === 'string' ? model.upstreamModelId : '';
};
