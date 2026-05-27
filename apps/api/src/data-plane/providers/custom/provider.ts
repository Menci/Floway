import { fetchCustomModels, type CustomModelsResponse, type CustomRawModel } from './fetch-models.ts';
import { inferKindFromModelId } from './infer-kind.ts';
import type { UpstreamRecord } from '../../../repo/types.ts';
import { createCustomUpstream } from '../../../shared/upstream/custom.ts';
import type { EndpointKey } from '../../../shared/upstream/types.ts';
import { isStreamingEndpoint, publicPathsToModelEndpoints } from '../endpoints.ts';
import { resolveEffectiveFlags } from '../flags-resolve.ts';
import { defaultsForProvider } from '../flags.ts';
import { inProcessMemo, isProviderModelsHttpStatus, readModelsStore, writeModelsStore } from '../models-store.ts';
import type { ModelProvider, ModelProviderInstance, ProviderCallResult, UpstreamModel } from '../types.ts';
import type { ModelEndpoint, ModelKind, ModelPricing } from '@floway-dev/protocols/common';

interface CustomProviderData {
  rawModelId: string;
}

interface CustomModelsBlob {
  response: CustomModelsResponse;
  fetchedAt: number;
}

const SOFT_MS = 10 * 60 * 1000;
const HARD_MS = 2 * 60 * 60 * 1000;
const L1_TTL_MS = 120_000;
const providerData = (model: UpstreamModel): CustomProviderData => model.providerData as CustomProviderData;

// Endpoint routing for custom upstreams is decided per-model: `kind` comes
// from a tiered detector (Tier 1: upstream /models published `kind`; Tier 2:
// id heuristic; default: 'chat'), and `upstreamEndpoints` is then derived
// from kind + the per-upstream `supportedEndpoints` config (which only
// declares chat-protocol availability). Display metadata (display_name /
// created) and `cost` are surfaced through to the public catalog when the
// upstream chose to publish them.
const customInternalModel = (model: CustomRawModel): Omit<UpstreamModel, 'kind' | 'upstreamEndpoints' | 'providerData' | 'enabledFlags'> => {
  const internal: Omit<UpstreamModel, 'kind' | 'upstreamEndpoints' | 'providerData' | 'enabledFlags'> = {
    id: model.id,
    limits: model.limits ? { ...model.limits } : {},
  };
  if (model.owned_by !== undefined) internal.owned_by = model.owned_by;
  // OpenAI carries unix `created`; Anthropic carries ISO `created_at`; our
  // own /models carries both. Prefer the unix integer when both are present,
  // otherwise derive it from the ISO string. We never store created_at on
  // UpstreamModel — the public catalog rederives it from `created` so the
  // internal shape stays single-source.
  if (model.created !== undefined) {
    internal.created = model.created;
  } else if (model.created_at !== undefined) {
    const ms = Date.parse(model.created_at);
    if (!Number.isNaN(ms)) internal.created = Math.floor(ms / 1000);
  }
  const display = model.display_name ?? model.name;
  if (display !== undefined) internal.display_name = display;
  if (model.cost) internal.cost = model.cost;
  return internal;
};

const resolveModelKind = (model: CustomRawModel): ModelKind => model.kind ?? inferKindFromModelId(model.id);

const finalizeCustomModels = (
  response: CustomModelsResponse,
  configuredChatEndpoints: readonly ModelEndpoint[],
  enabledFlags: ReadonlySet<string>,
): UpstreamModel[] => {
  const models: UpstreamModel[] = [];
  for (const rawModel of response.data) {
    if (!rawModel.id) continue;
    const kind = resolveModelKind(rawModel);
    const upstreamEndpoints: readonly ModelEndpoint[] =
      kind === 'embedding' ? ['embeddings']
        : kind === 'image' ? ['images_generations', 'images_edits']
          : configuredChatEndpoints;
    models.push({
      ...customInternalModel(rawModel),
      kind,
      upstreamEndpoints,
      providerData: { rawModelId: rawModel.id } satisfies CustomProviderData,
      enabledFlags,
    });
  }
  return models;
};

const pricingByRawIdFromResponse = (response: CustomModelsResponse): Map<string, ModelPricing> => {
  const pricing = new Map<string, ModelPricing>();
  for (const raw of response.data) {
    if (raw.id && raw.cost) pricing.set(raw.id, raw.cost);
  }
  return pricing;
};

export const createCustomProvider = (record: UpstreamRecord): ModelProviderInstance => {
  const upstream = createCustomUpstream(record);
  const configuredChatEndpoints = publicPathsToModelEndpoints(upstream.supportedEndpoints);
  // Computed once: only the upstream layer applies for this provider kind
  // (no per-model override layer). Azure recomputes per deployment.
  const upstreamFlags = resolveEffectiveFlags(defaultsForProvider('custom'), [record.flagOverrides]);

  // Last-known pricing keyed by raw model id. Populated whenever a fresh
  // /models response flows through finalize(); read synchronously by
  // getPricingForModelKey. Stays empty until the first list call lands.
  // TODO: layer admin-supplied per-model pricing overrides on top of this
  // when that feature ships, so admins can price upstreams whose /models
  // doesn't expose `cost`.
  let pricingByRawId: ReadonlyMap<string, ModelPricing> = new Map();
  const rememberPricing = (response: CustomModelsResponse): void => {
    pricingByRawId = pricingByRawIdFromResponse(response);
  };

  const call = (endpoint: EndpointKey, model: UpstreamModel, body: Record<string, unknown>, signal?: AbortSignal, headers?: Record<string, string>): Promise<ProviderCallResult> => {
    const requestBody = isStreamingEndpoint(endpoint)
      ? { ...body, stream: true, model: providerData(model).rawModelId }
      : { ...body, model: providerData(model).rawModelId };
    return upstream
      .fetch(endpoint, { method: 'POST', body: JSON.stringify(requestBody), signal }, { extraHeaders: headers })
      .then(response => ({
        response,
        modelKey: providerData(model).rawModelId,
      }));
  };

  const provider: ModelProvider = {
    getProvidedModels: () =>
      inProcessMemo(record.id, L1_TTL_MS, async () => {
        const stored = await readModelsStore<CustomModelsBlob>(record.id);
        const now = Date.now();
        if (stored && now - stored.fetchedAt < SOFT_MS) {
          rememberPricing(stored.response);
          return finalizeCustomModels(stored.response, configuredChatEndpoints, upstreamFlags);
        }
        try {
          const response = await fetchCustomModels(upstream);
          await writeModelsStore<CustomModelsBlob>(record.id, { response, fetchedAt: now });
          rememberPricing(response);
          return finalizeCustomModels(response, configuredChatEndpoints, upstreamFlags);
        } catch (err) {
          if (stored && now - stored.fetchedAt < HARD_MS && isProviderModelsHttpStatus(err, 429)) {
            rememberPricing(stored.response);
            return finalizeCustomModels(stored.response, configuredChatEndpoints, upstreamFlags);
          }
          throw err;
        }
      }),
    getPricingForModelKey: modelKey => pricingByRawId.get(modelKey) ?? null,
    callChatCompletions: (model, body, signal, headers) => call('chat_completions', model, body, signal, headers),
    callResponses: (model, body, signal, headers) => call('responses', model, body, signal, headers),
    callMessages: (model, body, signal, headers) => call('messages', model, body, signal, headers),
    callMessagesCountTokens: (model, body, signal, headers) => call('messages_count_tokens', model, body, signal, headers),
    callEmbeddings: (model, body, signal, headers) => call('embeddings', model, body, signal, headers),
    callImagesGenerations: (model, body, signal, headers) => call('images_generations', model, body, signal, headers),
    callImagesEdits: async (model, body, signal, headers) => {
      // Custom forwards the user's raw model id. The runtime auto-encodes
      // the FormData with a fresh boundary and sets Content-Type itself.
      body.append('model', providerData(model).rawModelId);
      const response = await upstream.fetch('images_edits', { method: 'POST', body, signal }, { extraHeaders: headers });
      return { response, modelKey: providerData(model).rawModelId };
    },
  };

  return {
    upstream: record.id,
    providerKind: 'custom',
    name: record.name,
    provider,
  };
};
