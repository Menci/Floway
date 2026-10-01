import { assertCustomUpstreamRecord } from './config.ts';
import { CUSTOM_DEFAULT_FLAGS } from './defaults.ts';
import { fetchCustomModels, type CustomModelsResponse, type CustomRawModel } from './fetch-models.ts';
import { inferEndpointsFromModelId } from './infer-endpoints.ts';
import { createCustomPipelines } from './pipelines.ts';
import { type ModelEndpoints, kindForEndpoints } from '@floway-dev/protocols/common';
import { publicModelId, resolveEffectiveFlags, type FlagId, type ProviderInstance, type Provider, type ProviderModel, type UpstreamModelConfig, type UpstreamRecord } from '@floway-dev/provider';

const rawModelIdOf = (model: ProviderModel): string => model.providerData as string;

const customRawToProviderModel = (model: CustomRawModel): Omit<ProviderModel, 'kind' | 'endpoints' | 'providerData' | 'enabledFlags'> => {
  const partial: Omit<ProviderModel, 'kind' | 'endpoints' | 'providerData' | 'enabledFlags'> = {
    id: model.id,
    upstreamModelId: model.id,
    limits: model.limits ? { ...model.limits } : {},
    opaqueBlobCompatibilityScope: model.opaqueBlobCompatibilityScope ?? { bindToUpstream: true },
  };
  if (model.owned_by !== undefined) partial.owned_by = model.owned_by;
  // OpenAI carries unix `created`; Anthropic carries ISO `created_at`; our
  // own /models carries both. Prefer the unix integer when both are present,
  // otherwise derive it from the ISO string. We never store created_at on
  // ProviderModel — the public catalog rederives it from `created` so the
  // internal shape stays single-source.
  if (model.created !== undefined) {
    partial.created = model.created;
  } else if (model.created_at !== undefined) {
    const ms = Date.parse(model.created_at);
    if (!Number.isNaN(ms)) partial.created = Math.floor(ms / 1000);
  }
  const display = model.display_name ?? model.name;
  if (display !== undefined) partial.display_name = display;
  if (model.pricing) partial.pricing = model.pricing;
  return partial;
};

// A published embedding/image/transcription kind maps directly to its endpoint;
// chat takes the upstream default. Rerank rows are removed before this helper
// because a kind alone cannot select their target wire. Unknown kinds use the
// id heuristic, then fall back to the configured endpoints.
const autoModelEndpoints = (model: CustomRawModel, configured: ModelEndpoints): ModelEndpoints => {
  if (model.kind === 'embedding') return { openaiEmbeddings: {} };
  if (model.kind === 'image') return { openaiImagesGenerations: {}, openaiImagesEdits: {} };
  if (model.kind === 'transcription') return { openaiAudioTranscriptions: {} };
  if (model.kind === 'chat') return configured;
  return inferEndpointsFromModelId(model.id) ?? configured;
};

export const projectCustomDiscoveredModels = (
  record: UpstreamRecord,
  response: CustomModelsResponse,
): UpstreamModelConfig[] => {
  const { config } = assertCustomUpstreamRecord(record);
  return response.data.map(model => {
    const endpoints = model.kind === 'rerank' ? { rerank: {} } : autoModelEndpoints(model, config.endpoints);
    const kind = model.kind === 'rerank' ? 'rerank' : kindForEndpoints(endpoints);
    const projected: UpstreamModelConfig = {
      upstreamModelId: model.id,
      publicModelId: model.id,
      kind,
      endpoints,
    };
    const displayName = model.display_name ?? model.name;
    if (displayName !== undefined) projected.display_name = displayName;
    if (model.limits !== undefined) projected.limits = { ...model.limits };
    if (model.pricing !== undefined) projected.pricing = model.pricing;
    if (kind === 'chat' && model.chat !== undefined) projected.chat = model.chat;
    projected.opaqueBlobCompatibilityScope = model.opaqueBlobCompatibilityScope ?? { bindToUpstream: true };
    return projected;
  });
};

const finalizeCustomModels = (
  response: CustomModelsResponse,
  configuredEndpoints: ModelEndpoints,
  enabledFlags: ReadonlySet<FlagId>,
): ProviderModel[] => {
  const models: ProviderModel[] = [];
  for (const rawModel of response.data) {
    if (!rawModel.id) continue;
    // A catalog kind alone cannot choose between the six incompatible rerank
    // wires. The auto row remains visible in the dashboard's fetch result, but
    // only a manual row with rerankTarget enters the routable provider catalog.
    if (rawModel.kind === 'rerank') continue;
    const endpoints = autoModelEndpoints(rawModel, configuredEndpoints);
    const kind = kindForEndpoints(endpoints);
    models.push({
      ...customRawToProviderModel(rawModel),
      kind,
      endpoints,
      providerData: rawModel.id,
      enabledFlags,
      ...(kind === 'chat' && rawModel.chat ? { chat: rawModel.chat } : {}),
    });
  }
  return models;
};

export const projectCustomModels = (
  record: UpstreamRecord,
  response?: CustomModelsResponse,
): ProviderModel[] => {
  const { config } = assertCustomUpstreamRecord(record);
  const configuredEndpoints = config.endpoints;
  // Only the upstream layer applies to auto models (no per-model override
  // layer). Manual models layer their own flag overrides on top.
  const upstreamFlags = resolveEffectiveFlags([CUSTOM_DEFAULT_FLAGS, record.flagOverrides]);

  // Manual models always emit.
  const overriddenIds = new Set(config.models.map(m => m.upstreamModelId));
  const manualModels: ProviderModel[] = config.models.map(model => {
    const enabledFlags = resolveEffectiveFlags([CUSTOM_DEFAULT_FLAGS, record.flagOverrides, model.flagOverrides]);
    const endpoints = model.endpoints;
    const kind = kindForEndpoints(endpoints);
    const internal: ProviderModel = {
      id: publicModelId(model),
      upstreamModelId: model.upstreamModelId,
      limits: { ...(model.limits ?? {}) },
      kind,
      endpoints,
      providerData: model.upstreamModelId,
      enabledFlags,
      opaqueBlobCompatibilityScope: model.opaqueBlobCompatibilityScope ?? { bindToUpstream: true },
      ...(model.rerankTarget ? { rerankTarget: model.rerankTarget } : {}),
    };
    if (model.display_name !== undefined) internal.display_name = model.display_name;
    if (model.pricing) internal.pricing = model.pricing;
    if (kind === 'chat' && model.chat) internal.chat = model.chat;
    return internal;
  });
  if (!config.modelsFetch.enabled || response === undefined) return manualModels;

  const fetchedPricing = new Map(
    response.data.flatMap(model => model.pricing ? [[model.id, model.pricing] as const] : []),
  );
  const effectiveManualModels = manualModels.map(model => {
    if (model.pricing !== undefined) return model;
    const pricing = fetchedPricing.get(rawModelIdOf(model));
    return pricing === undefined ? model : { ...model, pricing };
  });
  // Drop any auto-fetched model whose id is pinned by a manual override so
  // the manual copy is the only one emitted for that id.
  const filtered: CustomModelsResponse = { data: response.data.filter(raw => !overriddenIds.has(raw.id)) };
  return [...effectiveManualModels, ...finalizeCustomModels(filtered, configuredEndpoints, upstreamFlags)];
};

export const createCustomProvider = (record: UpstreamRecord): Provider => {
  const { config } = assertCustomUpstreamRecord(record);

  const instance: ProviderInstance = {
    getProvidedModels: async fetcher => {
      if (!config.modelsFetch.enabled) return projectCustomModels(record);
      const response = await fetchCustomModels(config, fetcher);
      return projectCustomModels(record, response);
    },
  };

  return {
    upstreamId: record.id,
    kind: 'custom',
    name: record.name,
    // Admission only has to carry the headers whose value comes from the
    // client. A rule with a configured value supplies its own value inside
    // this provider, so the client's copy is neither needed nor forwarded.
    inboundHeaderAllowlist: config.ingressHeadersRules.flatMap(rule => rule.value === null ? [rule.key] : []),
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    modelsCache: record.modelsCache,
    pipelines: createCustomPipelines(config),
    instance,
  };
};
