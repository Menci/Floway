import { chatFromCopilotRaw } from './chat-from-raw.ts';
import { assertCopilotUpstreamRecord } from './config.ts';
import { COPILOT_DEFAULT_FLAGS, defaultFlagsForCopilotModel } from './defaults.ts';
import { fetchCopilotModels } from './fetch-models.ts';
import { emptyKnownModels, mergeKnownModels, projectKnownModels } from './known-models.ts';
import { mergeCopilotVariants } from './merge-variants.ts';
import { type ModelSelectionHints, resolveCopilotRawModel } from './model-selection.ts';
import { copilotVariantIndex } from './model-variants.ts';
import { pricingForCopilotPublicModelId } from './pricing.ts';
import { readCopilotUpstreamState, type CopilotUpstreamState } from './state.ts';
import type { CopilotRawModel } from './types.ts';
import { type DecisionProtocol, type DecisionTarget, type ModelEndpointKey, type ModelEndpoints, kindForEndpoints } from '@floway-dev/protocols/common';
import { getUpstreamRuntimeRepo, resolveEffectiveFlags, type Fetcher, type FlagOverrides, type UpstreamModel, type UpstreamModelConfig, type UpstreamRecord } from '@floway-dev/upstream';

export interface CopilotUpstreamData {
  rawModels: CopilotRawModel[];
}

// Project Copilot's raw `/models` shape into the slim provider-neutral fields.
// kind/endpoints/upstreamData/enabledFlags/flagOverrides are set by the caller
// because they depend on Copilot's endpoint knowledge and the multi-layer
// flag resolution.
const copilotRawToUpstreamModel = (model: CopilotRawModel): Omit<UpstreamModel, 'kind' | 'endpoints' | 'upstreamData' | 'enabledFlags' | 'flagOverrides'> => {
  const limits: UpstreamModel['limits'] = {};
  if (model.capabilities?.limits?.max_output_tokens !== undefined) limits.max_output_tokens = model.capabilities.limits.max_output_tokens;
  if (model.capabilities?.limits?.max_context_window_tokens !== undefined) limits.max_context_window_tokens = model.capabilities.limits.max_context_window_tokens;
  if (model.capabilities?.limits?.max_prompt_tokens !== undefined) limits.max_prompt_tokens = model.capabilities.limits.max_prompt_tokens;

  const partial: Omit<UpstreamModel, 'kind' | 'endpoints' | 'upstreamData' | 'enabledFlags' | 'flagOverrides'> = {
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

// Copilot's `/models` reports each model's served endpoints as public paths; map
// one onto our structured endpoint key. Both `/x` and `/v1/x` spellings appear.
// Copilot is the only upstream whose catalog speaks paths — operator config and
// our own constants are structured — so this lives here, not in a shared helper.
const copilotPathToModelEndpoint = (path: string): ModelEndpointKey | undefined => {
  switch (path) {
  case '/chat/completions':
  case '/v1/chat/completions':
    return 'openaiChatCompletions';
  case '/responses':
  case '/v1/responses':
    return 'openaiResponses';
  case '/v1/messages':
  case '/messages':
    return 'anthropicMessages';
  case '/embeddings':
  case '/v1/embeddings':
    return 'openaiEmbeddings';
  case '/images/generations':
  case '/v1/images/generations':
    return 'openaiImagesGenerations';
  case '/images/edits':
  case '/v1/images/edits':
    return 'openaiImagesEdits';
  case '/systemone':
  case '/v1/systemone':
  case '/decisions':
  case '/v1/decisions':
    return 'decision';
  default:
    return undefined;
  }
};

// Copilot names the dialect each decision model serves through the path it
// advertises: `/v1/systemone` speaks System One and `/v1/decisions` speaks
// OpenAI Decisions. The two are exclusive per model — calling the other one
// answers 400 `no_available_model_endpoints` — so the advertised path is the
// only authority for the target dialect.
const COPILOT_DECISION_PATH_PROTOCOL: Readonly<Record<string, DecisionProtocol>> = {
  '/systemone': 'typesafe-systemone',
  '/v1/systemone': 'typesafe-systemone',
  '/decisions': 'openai-decisions',
  '/v1/decisions': 'openai-decisions',
};

const copilotDecisionTarget = (variants: readonly CopilotRawModel[]): DecisionTarget => {
  const advertised = variants.flatMap(variant => variant.supported_endpoints ?? []);
  const protocols = [...new Set(advertised.flatMap(path => COPILOT_DECISION_PATH_PROTOCOL[path] ?? []))];
  if (protocols.length !== 1) {
    throw new Error(
      `Copilot decision model advertises ${protocols.length === 0 ? 'no decision path' : `multiple decision dialects (${protocols.join(', ')})`} in supported_endpoints ${JSON.stringify(advertised)}`,
    );
  }
  return { protocol: protocols[0] };
};

const rawModelSupportsEndpoint = (model: CopilotRawModel, endpoint: ModelEndpointKey): boolean => {
  if ((model.supported_endpoints ?? []).some(path => copilotPathToModelEndpoint(path) === endpoint)) return true;
  // Copilot's Anthropic-family entries have historically under-reported their
  // native Anthropic Messages path, so treat claude-* as Anthropic-Messages-capable.
  if (endpoint === 'anthropicMessages' && model.id.startsWith('claude-')) return true;
  if (endpoint === 'openaiChatCompletions') {
    return model.supported_endpoints === undefined && model.capabilities?.type === 'chat';
  }
  if (endpoint === 'openaiEmbeddings') return model.supported_endpoints === undefined && model.capabilities?.type === 'embeddings';
  // A decision model declares `capabilities.type: "decisions"`. The advertised
  // path alone cannot decide this: the same family is reached over
  // `/v1/systemone` and `/v1/decisions`, and a catalog that omits
  // `supported_endpoints` (or lists a path this map does not know yet) would
  // otherwise fall through to the chat fallback and be routed to
  // /v1/chat/completions. The declared type is the authority.
  if (endpoint === 'decision') return model.capabilities?.type === 'decisions';
  return false;
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

  if (rawModels.some(model => rawModelSupportsEndpoint(model, 'openaiEmbeddings'))) return { openaiEmbeddings: {} };
  // Image models are their own family too, but unlike the chat collapse above
  // they advertise two independently routable surfaces: the gateway serves
  // `/v1/images/generations` and `/v1/images/edits` as separate inbound routes,
  // so a model that declares both must carry both keys. Copilot's live
  // `gpt-image-2.5-flare` entry lists both paths and serves real requests on
  // each, and declaring only one would make the other route reject the model.
  const imageEndpoints: ModelEndpoints = {
    ...(rawModels.some(model => rawModelSupportsEndpoint(model, 'openaiImagesGenerations')) ? { openaiImagesGenerations: {} } : {}),
    ...(rawModels.some(model => rawModelSupportsEndpoint(model, 'openaiImagesEdits')) ? { openaiImagesEdits: {} } : {}),
  };
  if (Object.keys(imageEndpoints).length > 0) return imageEndpoints;
  // A decision model is a family of one: no other endpoint family shares its
  // row, so this branch never competes with the chat/embeddings collapse above.
  return rawModels.some(model => rawModelSupportsEndpoint(model, 'decision')) ? { decision: {} } : {};
};

export const rawModelFor = (model: Pick<UpstreamModel, 'id' | 'upstreamData'>, endpoint: ModelEndpointKey, hints: ModelSelectionHints = {}): CopilotRawModel => {
  // Copilot exposes one canonical public Claude model id per family. Raw
  // variant selection is derived from request body fields and parsed Anthropic Messages
  // beta intent, not from the client's original model alias string.
  const rawModels = (model.upstreamData as CopilotUpstreamData).rawModels.filter(rawModel => rawModelSupportsEndpoint(rawModel, endpoint));
  if (rawModels.length === 0) {
    throw new Error(`Copilot upstream exposed ${endpoint} for ${model.id}, but no raw variant supports that endpoint`);
  }
  return resolveCopilotRawModel({ object: 'list', data: rawModels }, model.id, hints) ?? rawModels[0];
};

const finalizeCopilotModels = (
  rawModels: CopilotRawModel[],
  upstreamOverrides: FlagOverrides,
): UpstreamModel[] => {
  const index = copilotVariantIndex(rawModels);
  const merged = mergeCopilotVariants(index);

  const models: UpstreamModel[] = [];
  for (const mergedModel of merged) {
    const variants = index.families.get(mergedModel.id);
    if (variants === undefined) {
      const rawIds = rawModels.length === 0 ? 'none' : rawModels.map(model => model.id).join(', ');
      throw new Error(`Copilot model projection invariant violated: merged model '${mergedModel.id}' has no raw variant group (raw model ids: ${rawIds})`);
    }
    const endpoints = copilotModelEndpoints(variants);
    const pricing = pricingForCopilotPublicModelId(mergedModel.id);
    const draft: Omit<UpstreamModel, 'enabledFlags'> = {
      ...copilotRawToUpstreamModel(mergedModel),
      upstreamModelId: mergedModel.id,
      kind: kindForEndpoints(endpoints),
      endpoints,
      upstreamData: { rawModels: variants } satisfies CopilotUpstreamData,
      ...(endpoints.decision ? { decisionTarget: copilotDecisionTarget(variants) } : {}),
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

export const getCopilotModels = async (record: UpstreamRecord, fetcher: Fetcher, _manualModels?: readonly UpstreamModelConfig[]): Promise<UpstreamModel[]> => {
  const copilot = assertCopilotUpstreamRecord(record);
  const upstreamConfig = { id: copilot.id, githubHost: copilot.config.githubHost, githubToken: copilot.config.githubToken };
  const fresh = await getUpstreamRuntimeRepo().upstreams.getById(copilot.id);
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
    await getUpstreamRuntimeRepo().upstreams.saveState(copilot.id, current => {
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
};
