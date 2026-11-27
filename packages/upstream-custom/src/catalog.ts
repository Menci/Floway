import { assertCustomUpstreamRecord, type CustomUpstreamRecord } from './config.ts';
import { CUSTOM_DEFAULT_FLAGS } from './defaults.ts';
import { fetchCustomModels, type CustomModelsResponse, type CustomRawModel } from './fetch-models.ts';
import { inferEndpointsFromModelId } from './infer-endpoints.ts';
import { type ModelEndpoints, kindForEndpoints } from '@floway-dev/protocols/common';
import { publicModelId, resolveEffectiveFlags, type Fetcher, type FlagId, type UpstreamModel, type UpstreamModelConfig, type UpstreamRecord } from '@floway-dev/upstream';

const customRawToUpstreamModel = (model: CustomRawModel): Omit<UpstreamModel, 'kind' | 'endpoints' | 'enabledFlags'> => {
  const partial: Omit<UpstreamModel, 'kind' | 'endpoints' | 'enabledFlags'> = {
    id: model.id,
    upstreamModelId: model.id,
    limits: model.limits ? { ...model.limits } : {},
    opaqueBlobCompatibilityScope: model.opaqueBlobCompatibilityScope ?? { bindToUpstream: true },
  };
  if (model.owned_by !== undefined) partial.owned_by = model.owned_by;
  // OpenAI carries unix `created`; Anthropic carries ISO `created_at`; our
  // own /models carries both. Prefer the unix integer when both are present,
  // otherwise derive it from the ISO string. We never store created_at on
  // UpstreamModel — the public catalog rederives it from `created` so the
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

// Published endpoint kinds take precedence over model ID inference. A chat
// row uses the endpoint capabilities configured for this upstream.
const autoModelEndpoints = (model: CustomRawModel, configured: ModelEndpoints): ModelEndpoints => {
  if (model.kind === 'embedding') return { openaiEmbeddings: {} };
  if (model.kind === 'image') return { openaiImagesGenerations: {}, openaiImagesEdits: {} };
  if (model.kind === 'speech') return { openaiAudioSpeech: {} };
  if (model.kind === 'transcription') return { openaiAudioTranscriptions: {} };
  if (model.kind === 'chat') return configured;
  return inferEndpointsFromModelId(model.id) ?? configured;
};

const finalizeCustomModels = (
  response: CustomModelsResponse,
  configuredEndpoints: ModelEndpoints,
  enabledFlags: ReadonlySet<FlagId>,
): UpstreamModel[] => {
  const models: UpstreamModel[] = [];
  for (const rawModel of response.data) {
    if (!rawModel.id) continue;
    // A catalog kind alone cannot choose between the six incompatible rerank
    // wires. The auto row remains visible in the dashboard's fetch result, but
    // only a manual row with rerankTarget enters the routable provider catalog.
    if (rawModel.kind === 'rerank' || rawModel.kind === 'decision') continue;
    const endpoints = autoModelEndpoints(rawModel, configuredEndpoints);
    const kind = kindForEndpoints(endpoints);
    models.push({
      ...customRawToUpstreamModel(rawModel),
      kind,
      endpoints,
      enabledFlags,
      ...(kind === 'chat' && rawModel.chat ? { chat: rawModel.chat } : {}),
    });
  }
  return models;
};

const projectManualModels = (
  record: CustomUpstreamRecord,
  manualModels: readonly UpstreamModelConfig[],
): UpstreamModel[] => {
  return manualModels.map(model => {
    const enabledFlags = resolveEffectiveFlags([CUSTOM_DEFAULT_FLAGS, record.flagOverrides, model.flagOverrides]);
    const endpoints = model.endpoints;
    const kind = kindForEndpoints(endpoints);
    const internal: UpstreamModel = {
      id: publicModelId(model),
      upstreamModelId: model.upstreamModelId,
      limits: { ...(model.limits ?? {}) },
      kind,
      endpoints,
      enabledFlags,
      opaqueBlobCompatibilityScope: model.opaqueBlobCompatibilityScope ?? { bindToUpstream: true },
      ...(model.rerankTarget ? { rerankTarget: model.rerankTarget } : {}),
      ...(model.decisionTarget ? { decisionTarget: model.decisionTarget } : {}),
    };
    if (model.display_name !== undefined) internal.display_name = model.display_name;
    if (model.pricing) internal.pricing = model.pricing;
    if (kind === 'chat' && model.chat) internal.chat = model.chat;
    return internal;
  });
};

const projectModels = (
  record: CustomUpstreamRecord,
  manualModels: readonly UpstreamModelConfig[],
  response?: CustomModelsResponse,
): UpstreamModel[] => {
  const { config } = record;
  const configuredEndpoints = config.endpoints;
  // Only the upstream layer applies to auto models (no per-model override
  // layer). Manual models layer their own flag overrides on top.
  const upstreamFlags = resolveEffectiveFlags([CUSTOM_DEFAULT_FLAGS, record.flagOverrides]);
  const effectiveManualModels = projectManualModels(record, manualModels);

  if (!config.modelsFetch.enabled || response === undefined) {
    return effectiveManualModels;
  }

  const overriddenIds = new Set(manualModels.map(m => m.upstreamModelId));
  // Drop any auto-fetched model whose id is pinned by a manual override so
  // the manual copy is the only one emitted for that id.
  const filtered: CustomModelsResponse = { data: response.data.filter(raw => !overriddenIds.has(raw.id)) };
  return [...effectiveManualModels, ...finalizeCustomModels(filtered, configuredEndpoints, upstreamFlags)];
};

// A model is admitted if it has a string `id` (Gemini spells it inside
// `name`); everything else is best-effort metadata. The container is admitted

export const projectCustomManualModels = (record: UpstreamRecord, manualModels: readonly UpstreamModelConfig[]): UpstreamModel[] =>
  projectManualModels(assertCustomUpstreamRecord(record), manualModels);

export const projectCustomModels = (record: UpstreamRecord, manualModels: readonly UpstreamModelConfig[], response?: CustomModelsResponse): UpstreamModel[] =>
  projectModels(assertCustomUpstreamRecord(record), manualModels, response);

export const getCustomModels = async (
  record: UpstreamRecord,
  fetcher: Fetcher,
  manualModels: readonly UpstreamModelConfig[] = [],
): Promise<UpstreamModel[]> => {
  const upstream = assertCustomUpstreamRecord(record);
  const response = upstream.config.modelsFetch.enabled ? await fetchCustomModels(upstream.config, fetcher) : undefined;
  return projectModels(upstream, manualModels, response);
};
