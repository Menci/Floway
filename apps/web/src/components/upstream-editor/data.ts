import type { InferRequestType } from 'hono/client';

import { api, callApi } from '../../api/client';
import type {
  BackoffRow,
  CustomRawModel,
  ListUpstreamModelsResponse,
  ProxyRecord,
  UpstreamRecord,
  UpstreamRecordEnvelope,
} from '../../api/types';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { UpstreamModelConfig } from '@floway-dev/provider';
import type { UpstreamProviderKind } from '@floway-dev/provider/model';
import { MODEL_PREFIX_MAX_LENGTH, MODEL_PREFIX_REGEX } from '@floway-dev/provider/model-prefix';

type CreateUpstreamBody = InferRequestType<typeof api.api.upstreams.$post>['json'];
type UpdateUpstreamBody = InferRequestType<typeof api.api.upstreams[':id']['$patch']>['json'];

export interface RuntimeInfo {
  kind: 'node' | 'cloudflare';
  runtimeLocation: string;
}

export interface EditorAuxData {
  proxies: ProxyRecord[];
  backoffs: BackoffRow[];
  runtime: RuntimeInfo;
  upstreams: UpstreamRecord[];
}

interface UpstreamEditorLoaderDataBase extends EditorAuxData {
  record: UpstreamRecord;
  discovered: UpstreamModelConfig[];
  modelsError: string | null;
}

export type UpstreamEditorLoaderData = UpstreamEditorLoaderDataBase & (
  | { mode: 'create' }
  | { mode: 'edit' }
);

// The create form opens on a blueprint the gateway hands out with an empty id,
// which the first save replaces with the stored record. So this asks whether
// the record has a row, not whether the page is the create page: after a
// create the editor stays mounted, on loader mode 'create', over a persisted
// record.
export const isPersisted = (record: UpstreamRecord): boolean => record.id !== '';

// `hasAuto` says the upstream also lists the model, which is what makes
// switching the row back to `auto` possible.
export interface ModelRow {
  key: string;
  source: 'auto' | 'manual';
  config: UpstreamModelConfig;
  manualIndex: number | null;
  hasAuto: boolean;
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

export const providerDefaultName: Record<UpstreamProviderKind, string> = {
  custom: 'Custom upstream',
  azure: 'Azure AI',
  copilot: 'GitHub Copilot',
  codex: 'ChatGPT Codex',
  'claude-code': 'Claude Code',
  ollama: 'Ollama',
};

export const loadEditorAux = async (): Promise<EditorAuxData> => {
  const [proxies, backoffs, runtime, upstreams] = await Promise.all([
    callApi(() => api.api.proxies.$get()),
    callApi(() => api.api.proxies.backoffs.$get()),
    callApi(() => api.api['runtime-info'].$get()),
    callApi(() => api.api.upstreams.$get()),
  ]);
  const error = proxies.error ?? backoffs.error ?? runtime.error ?? upstreams.error;
  if (error) throw new Error(error.message);
  return {
    proxies: proxies.data!,
    backoffs: backoffs.data!,
    runtime: runtime.data!,
    upstreams: upstreams.data!,
  };
};

// Whether a listing request has anything to ask with. It reads the edited
// config rather than the stored one, so the switch and the base URL the
// operator is typing decide, and it is the single answer behind the loader,
// the refresh action and the refresh button.
export const canFetchModelCatalog = (record: UpstreamRecord, config: UpstreamEditorValues['config']): boolean => {
  switch (record.kind) {
  case 'custom': {
    const custom = config as Extract<UpstreamRecord, { kind: 'custom' }>['config'];
    return Boolean(custom.baseUrl) && custom.modelsFetch.enabled;
  }
  case 'ollama':
    return Boolean((config as Extract<UpstreamRecord, { kind: 'ollama' }>['config']).baseUrl);
  case 'azure':
    return false;
  default:
    return isPersisted(record);
  }
};

// Manual entries exist only for the kinds whose stored config carries a model
// list. For the rest the catalog is the provider's, and the editor can only
// enable and disable what it lists.
export const manualModelsSupported = (kind: UpstreamProviderKind): kind is 'custom' | 'azure' | 'ollama' =>
  kind === 'custom' || kind === 'azure' || kind === 'ollama';

export interface ModelCatalogFetch {
  /** Null when nothing was listed, which leaves whatever the caller already shows. */
  discovered: UpstreamModelConfig[] | null;
  modelsError: string | null;
  refreshed: UpstreamRecord | null;
}

// Listing re-reads the upstream afterwards: the server writes its models cache
// as a side effect of the call, and the record the editor holds carries it.
export const fetchModelCatalog = async (
  record: UpstreamRecord,
  values: UpstreamEditorValues,
  init?: RequestInit,
): Promise<ModelCatalogFetch> => {
  if (!canFetchModelCatalog(record, values.config)) return { discovered: null, modelsError: null, refreshed: null };

  const result = await callApi(() => api.api.upstreams['list-models'].$post({
    json: { record: previewRecord(record, values) },
  }, { init }));
  if (result.error) return { discovered: null, modelsError: result.error.message, refreshed: null };

  const endpoints = record.kind === 'custom'
    ? (values.config as Extract<UpstreamRecord, { kind: 'custom' }>['config']).endpoints
    : {};
  const discovered = discoveredModelsFromResponse(result.data, endpoints);
  if (!isPersisted(record)) return { discovered, modelsError: null, refreshed: null };

  const refreshed = await callApi(() => api.api.upstreams[':id'].$get({ param: { id: record.id } }, { init }));
  return refreshed.error
    ? { discovered, modelsError: refreshed.error.message, refreshed: null }
    : { discovered, modelsError: null, refreshed: refreshed.data };
};

export const loadInitialModelCatalog = async (record: UpstreamRecord) => {
  const { discovered, modelsError, refreshed } = await fetchModelCatalog(record, valuesFromRecord(record));
  return { discovered: discovered ?? [], modelsError, record: refreshed ?? record };
};

export const valuesFromRecord = (record: UpstreamRecord): UpstreamEditorValues => {
  const config: UpstreamRecord['config'] = record.kind === 'custom'
    ? {
        ...structuredClone(record.config),
        apiKey: '',
        ...(!isPersisted(record) && Object.keys(record.config.endpoints).length === 0
          ? { endpoints: { chatCompletions: {} }, modelsFetch: { ...record.config.modelsFetch, enabled: true } }
          : {}),
      }
    : record.kind === 'azure'
      ? { ...structuredClone(record.config), apiKey: '' }
      : record.kind === 'ollama'
        ? { ...structuredClone(record.config), apiKey: '' }
        : structuredClone(record.config);
  const manualModels = manualModelsSupported(record.kind) ? structuredClone(record.config.models) : [];
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
};

// The editor holds one flat form model for every provider kind, so the config
// is assembled structurally and only becomes a specific union member here.
const configFromValues = (
  record: UpstreamRecord,
  values: UpstreamEditorValues,
  options: { preserveStoredSecret?: boolean } = {},
): UpstreamRecord['config'] => {
  const config = structuredClone(values.config) as unknown as Record<string, unknown>;
  if (manualModelsSupported(record.kind)) {
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
};

export const previewRecord = (record: UpstreamRecord, values: UpstreamEditorValues): UpstreamRecordEnvelope => {
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
};

// `sort_order` is left out: the server appends a new upstream after the last
// one when the field is absent, and the list page owns reordering afterwards.
export const createBody = (record: UpstreamRecord, values: UpstreamEditorValues): CreateUpstreamBody => {
  return {
    kind: record.kind,
    name: values.name.trim(),
    enabled: values.enabled,
    color: values.color,
    flag_overrides: values.flagOverrides,
    disabled_public_model_ids: values.disabledPublicModelIds,
    proxy_fallback_list: values.proxyFallbackList,
    model_prefix: values.modelPrefix,
    config: configFromValues(record, values),
    ...((record.kind === 'copilot' || record.kind === 'codex' || record.kind === 'claude-code')
      ? { state: values.state }
      : {}),
  } as CreateUpstreamBody;
};

export const updateBody = (record: UpstreamRecord, values: UpstreamEditorValues): UpdateUpstreamBody => {
  return {
    name: values.name.trim(),
    enabled: values.enabled,
    color: values.color,
    flag_overrides: values.flagOverrides,
    disabled_public_model_ids: values.disabledPublicModelIds,
    proxy_fallback_list: values.proxyFallbackList,
    model_prefix: values.modelPrefix,
    ...(manualModelsSupported(record.kind) ? { config: configFromValues(record, values) } : {}),
  } as UpdateUpstreamBody;
};

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

export const discoveredModelsFromResponse = (
  response: ListUpstreamModelsResponse,
  endpoints: ModelEndpoints,
): UpstreamModelConfig[] => {
  if (response.kind !== 'custom') return response.data;
  return response.data.map(model => {
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
};

export const modelPrefixIsValid = (prefix: string) =>
  MODEL_PREFIX_REGEX.test(prefix) && prefix.length <= MODEL_PREFIX_MAX_LENGTH;

export const publicModelId = (model: UpstreamModelConfig) => {
  const configured = typeof model.publicModelId === 'string' ? model.publicModelId.trim() : '';
  if (configured) return configured;
  return typeof model.upstreamModelId === 'string' ? model.upstreamModelId : '';
};
