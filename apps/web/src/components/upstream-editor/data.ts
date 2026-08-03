import type { InferRequestType } from 'hono/client';

import { configuredEndpoints, PATH_OVERRIDE_PATHS, shapeForKind } from './endpoints';
import { api, callApi } from '../../api/client';
import type {
  BackoffRow,
  ListUpstreamModelsResponse,
  ProxyRecord,
  UpstreamRecord,
  UpstreamRecordEnvelope,
} from '../../api/types';
import type { MODEL_LISTING_FAILURE_CODE as GatewayModelListingFailureCode } from '@floway-dev/gateway/data-plane/models/shared';
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
  modelsError: ModelListingFailure | null;
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
  hue: UpstreamRecord['hue'];
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
export const manualModelsSupported = (record: UpstreamRecord): record is Extract<UpstreamRecord, { kind: 'custom' | 'azure' | 'ollama' }> =>
  record.kind === 'custom' || record.kind === 'azure' || record.kind === 'ollama';

export interface ModelCatalogFetch {
  /** Null when nothing was listed, which leaves whatever the caller already shows. */
  discovered: UpstreamModelConfig[] | null;
  modelsError: ModelListingFailure | null;
  refreshed: UpstreamRecord | null;
}

// The gateway squashes a genuine upstream failure to a message that names
// nothing, so the editor writes that case in its own words and quotes every
// other message. The code carries that distinction, and taking its type from
// the gateway makes a rename there fail this declaration.
const MODEL_LISTING_FAILURE_CODE: typeof GatewayModelListingFailureCode = 'upstream_model_listing_failed';

// Hono infers one response union for the route rather than one per status, so
// the failure body is read structurally.
const failureCode = (raw: unknown): unknown =>
  typeof raw === 'object' && raw !== null && 'error' in raw
  && typeof raw.error === 'object' && raw.error !== null && 'code' in raw.error
    ? raw.error.code
    : null;

export interface ModelListingFailure {
  message: string;
  upstreamListingFailed: boolean;
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
  if (result.error) {
    return {
      discovered: null,
      modelsError: {
        message: result.error.message,
        upstreamListingFailed: failureCode(result.error.raw) === MODEL_LISTING_FAILURE_CODE,
      },
      refreshed: null,
    };
  }

  const endpoints = record.kind === 'custom'
    ? (values.config as Extract<UpstreamRecord, { kind: 'custom' }>['config']).endpoints
    : {};
  const discovered = discoveredModelsFromResponse(result.data, endpoints);
  if (!isPersisted(record)) return { discovered, modelsError: null, refreshed: null };

  const refreshed = await callApi(() => api.api.upstreams[':id'].$get({ param: { id: record.id } }, { init }));
  return refreshed.error
    ? { discovered, modelsError: { message: refreshed.error.message, upstreamListingFailed: false }, refreshed: null }
    : { discovered, modelsError: null, refreshed: refreshed.data };
};

export const loadInitialModelCatalog = async (record: UpstreamRecord) => {
  const { discovered, modelsError, refreshed } = await fetchModelCatalog(record, valuesFromRecord(record));
  return { discovered: discovered ?? [], modelsError, record: refreshed ?? record };
};

// A field react-hook-form has registered owns its key from then on: mounting it
// writes the key into the edited values even when nothing filled it in, and
// dirtiness is decided by comparing those values against the ones the form
// opened with -- key by key, so a key one side lacks entirely reads as an edit.
// An optional field therefore opens with its key already present and empty, and
// every optional field the editor registers needs that seed.
const withRegisteredKey = <T extends object, K extends keyof T>(key: K, value: T): T =>
  ({ [key]: undefined, ...value }) as T;

export const valuesFromRecord = (record: UpstreamRecord): UpstreamEditorValues => {
  const config: UpstreamRecord['config'] = record.kind === 'custom'
    ? {
        ...structuredClone(record.config),
        apiKey: '',
        // The override fields register the whole map, so the edited value
        // carries every listed path whether or not the stored config does.
        // Seeding the blanks keeps the saved state and the edited state the
        // same shape; configFromValues drops the map again when all of it is
        // blank, and a stored path the form does not list survives the merge.
        pathOverrides: { ...Object.fromEntries(PATH_OVERRIDE_PATHS.map(path => [path, ''])), ...record.config.pathOverrides },
        modelsFetch: withRegisteredKey('endpoint', structuredClone(record.config.modelsFetch)),
      }
    : record.kind === 'azure'
      ? { ...structuredClone(record.config), apiKey: '' }
      : record.kind === 'ollama'
        ? { ...structuredClone(record.config), apiKey: '' }
        : structuredClone(record.config);
  const manualModels = manualModelsSupported(record) ? structuredClone(record.config.models) : [];
  return {
    name: record.name,
    enabled: record.enabled,
    hue: record.hue,
    proxyFallbackList: structuredClone(record.proxy_fallback_list).map(entry => withRegisteredKey('colos', entry)),
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
  if (manualModelsSupported(record)) {
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
    hue: values.hue,
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
    hue: values.hue,
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
    hue: values.hue,
    flag_overrides: values.flagOverrides,
    disabled_public_model_ids: values.disabledPublicModelIds,
    proxy_fallback_list: values.proxyFallbackList,
    model_prefix: values.modelPrefix,
    ...(manualModelsSupported(record) ? { config: configFromValues(record, values) } : {}),
  } as UpdateUpstreamBody;
};

export const discoveredModelsFromResponse = (
  response: ListUpstreamModelsResponse,
  endpoints: ModelEndpoints,
): UpstreamModelConfig[] => {
  if (response.kind !== 'custom') return response.data;
  return response.data.map(model => {
    const kind = model.kind ?? 'chat';
    return {
      upstreamModelId: model.id,
      publicModelId: model.id,
      kind,
      ...(kind === 'chat' ? { endpoints: configuredEndpoints(endpoints) } : shapeForKind(kind, { endpoints })),
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
