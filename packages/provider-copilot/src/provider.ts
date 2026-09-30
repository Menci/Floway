import { chatFromCopilotRaw } from './chat-from-raw.ts';
import { assertCopilotUpstreamRecord } from './config.ts';
import { COPILOT_DEFAULT_FLAGS, defaultFlagsForCopilotModel } from './defaults.ts';
import { fetchCopilotModels } from './fetch-models.ts';
import { emptyKnownModels, mergeKnownModels, projectKnownModels } from './known-models.ts';
import { mergeCopilotVariants } from './merge-variants.ts';
import { copilotVariantIndex } from './model-variants.ts';
import { rawModelSupportsEndpoint } from './operation-model.ts';
import { createCopilotPipelines } from './pipelines.ts';
import { pricingForCopilotPublicModelId } from './pricing.ts';
import { readCopilotUpstreamState, type CopilotUpstreamState } from './state.ts';
import type { CopilotRawModel } from './types.ts';
import { type ModelEndpoints, kindForEndpoints } from '@floway-dev/protocols/common';
import { getProviderRepo, resolveEffectiveFlags, type FlagOverrides, type ProviderInstance, type Provider, type ProviderModel, type UpstreamRecord } from '@floway-dev/provider';

interface CopilotProviderData {
  rawModels: CopilotRawModel[];
}

// Project Copilot's raw `/models` shape into the slim provider-neutral fields.
// kind/endpoints/providerData/enabledFlags/flagOverrides are set by the caller
// because they depend on Copilot's endpoint knowledge and the multi-layer
// flag resolution.
const copilotRawToProviderModel = (model: CopilotRawModel): Omit<ProviderModel, 'kind' | 'endpoints' | 'providerData' | 'enabledFlags' | 'flagOverrides'> => {
  const limits: ProviderModel['limits'] = {};
  if (model.capabilities?.limits?.max_output_tokens !== undefined) limits.max_output_tokens = model.capabilities.limits.max_output_tokens;
  if (model.capabilities?.limits?.max_context_window_tokens !== undefined) limits.max_context_window_tokens = model.capabilities.limits.max_context_window_tokens;
  if (model.capabilities?.limits?.max_prompt_tokens !== undefined) limits.max_prompt_tokens = model.capabilities.limits.max_prompt_tokens;

  const partial: Omit<ProviderModel, 'kind' | 'endpoints' | 'providerData' | 'enabledFlags' | 'flagOverrides'> = {
    id: model.id,
    upstreamModelId: model.id,
    limits,
    opaqueBlobCompatibilityScope: { bindToUpstream: true },
  };
  if (model.owned_by !== undefined) partial.owned_by = model.owned_by;
  if (model.created !== undefined) partial.created = model.created;
  const displayName = model.display_name ?? model.name;
  if (displayName !== undefined) partial.display_name = displayName;
  const chat = chatFromCopilotRaw(model);
  if (chat !== undefined) partial.chat = chat;
  return partial;
};

const copilotModelEndpoints = (rawModels: readonly CopilotRawModel[]): ModelEndpoints => {
  if (rawModels.some(model => rawModelSupportsEndpoint(model, 'openaiResponses'))) {
    return { openaiResponses: {} };
  }

  if (rawModels.some(model => rawModelSupportsEndpoint(model, 'anthropicMessages'))) {
    return { anthropicMessages: {} };
  }

  if (rawModels.some(model => rawModelSupportsEndpoint(model, 'openaiChatCompletions'))) {
    return { openaiChatCompletions: {} };
  }

  return rawModels.some(model => rawModelSupportsEndpoint(model, 'openaiEmbeddings')) ? { openaiEmbeddings: {} } : {};
};

const finalizeCopilotModels = (
  rawModels: CopilotRawModel[],
  upstreamOverrides: FlagOverrides,
): ProviderModel[] => {
  const index = copilotVariantIndex(rawModels);
  const merged = mergeCopilotVariants(index);

  const models: ProviderModel[] = [];
  for (const mergedModel of merged) {
    const variants = index.families.get(mergedModel.id);
    if (variants === undefined) {
      const rawIds = rawModels.length === 0 ? 'none' : rawModels.map(model => model.id).join(', ');
      throw new Error(`Copilot model projection invariant violated: merged model '${mergedModel.id}' has no raw variant group (raw model ids: ${rawIds})`);
    }
    const endpoints = copilotModelEndpoints(variants);
    const pricing = pricingForCopilotPublicModelId(mergedModel.id);
    const draft: Omit<ProviderModel, 'enabledFlags'> = {
      ...copilotRawToProviderModel(mergedModel),
      upstreamModelId: mergedModel.id,
      kind: kindForEndpoints(endpoints),
      endpoints,
      providerData: { rawModels: variants } satisfies CopilotProviderData,
      ...(pricing ? { pricing } : {}),
      ...((mergedModel.owned_by?.toLowerCase() === 'openai' || /^(?:gpt-|o[134](?:-|$)|codex-)/.test(mergedModel.id))
        ? { opaqueBlobCompatibilityScope: { bindToUpstream: true, key: 'openai' } }
        : {}),
    };
    // Layer order: provider upstream default → operator upstream override
    // → per-model provider default. Placing the per-model layer last
    // keeps a technical necessity the provider knows about (Vertex
    // rejects inline `role:'system'` for Claude < 4.8; see
    // `defaultFlagsForCopilotModel`) from being silently undone by the
    // operator's upstream toggle. The same per-model overlay is surfaced
    // on `flagOverrides` so the dashboard can show which flags the
    // provider forces on this specific model.
    const flagOverrides = defaultFlagsForCopilotModel(draft);
    const enabledFlags = resolveEffectiveFlags([COPILOT_DEFAULT_FLAGS, upstreamOverrides, flagOverrides]);
    models.push({
      ...draft,
      enabledFlags,
      ...(Object.keys(flagOverrides).length > 0 ? { flagOverrides } : {}),
    });
  }
  return models;
};

export const createCopilotProvider = (record: UpstreamRecord): Provider => {
  const copilot = assertCopilotUpstreamRecord(record);
  const upstreamConfig = { id: copilot.id, githubHost: copilot.config.githubHost, githubToken: copilot.config.githubToken };

  const instance: ProviderInstance = {
    getProvidedModels: async fetcher => {
      const fresh = await getProviderRepo().upstreams.getById(copilot.id);
      if (!fresh) throw new Error(`Copilot upstream ${copilot.id} disappeared mid-request`);
      const known = readCopilotUpstreamState(fresh.state).knownModels ?? emptyKnownModels();
      const response = await fetchCopilotModels(upstreamConfig, fetcher);
      const now = Date.now();
      const merged = mergeKnownModels(known, response, now);
      // The accumulator merges into whatever is stored at write time, not into
      // the snapshot read before the fetch — fetchCopilotModels may have minted
      // a token and written this same row on the way through. Persistence stays
      // best-effort: the fetched catalog is what the caller is about to serve,
      // and a storage failure only costs the next call the entries this one
      // would have added.
      try {
        await getProviderRepo().upstreams.saveState(copilot.id, current => {
          const state = readCopilotUpstreamState(current);
          return {
            ...state,
            knownModels: mergeKnownModels(state.knownModels ?? emptyKnownModels(), response, now),
          } satisfies CopilotUpstreamState;
        });
      } catch (err) {
        console.warn(`Failed to persist Copilot known-models for ${copilot.id}:`, err);
      }
      return finalizeCopilotModels(projectKnownModels(merged, now), copilot.flagOverrides);
    },
  };

  return {
    upstreamId: copilot.id,
    kind: 'copilot',
    name: copilot.name,
    inboundHeaderAllowlist: [],
    disabledPublicModelIds: copilot.disabledPublicModelIds,
    modelPrefix: copilot.modelPrefix,
    modelsCache: copilot.modelsCache,
    pipelines: createCopilotPipelines(upstreamConfig),
    instance,
  };
};
