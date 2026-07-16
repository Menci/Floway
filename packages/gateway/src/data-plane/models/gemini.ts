import type { Context } from 'hono';

import { MODEL_LISTING_FAILURE_MESSAGE } from './shared.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { getRepo } from '../../repo/index.ts';
import type { ModelAliasesRepo } from '../../repo/types.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import { geminiStatusForHttpStatus } from '../chat/gemini/errors.ts';
import { enumerateAddressableModelIds, listedRealModels } from '../shared/listing/addressable.ts';
import { mergeAliasesIntoModels } from '../shared/listing/alias.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ModelPricing } from '@floway-dev/protocols/common';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';
import type { InternalModel, Fetcher } from '@floway-dev/provider';

type GeminiGenerationMethod = 'generateContent' | 'streamGenerateContent' | 'countTokens';

interface GeminiModel {
  name: string;
  baseModelId?: string;
  version?: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: GeminiGenerationMethod[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  temperature?: number;
  maxTemperature?: number;
  topP?: number;
  topK?: number;
  pricing?: ModelPricing;
}

const toGeminiModel = (model: InternalModel): GeminiModel => {
  const limits = model.limits;
  const inputTokenLimit = limits.max_prompt_tokens ?? limits.max_context_window_tokens;
  const outputTokenLimit = limits.max_output_tokens;

  return {
    name: `models/${model.id}`,
    baseModelId: model.id,
    displayName: model.display_name ?? model.id,
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
    ...(inputTokenLimit !== undefined ? { inputTokenLimit } : {}),
    ...(outputTokenLimit !== undefined ? { outputTokenLimit } : {}),
    temperature: 1,
    topP: 0.95,
    topK: 40,
    ...(model.pricing ? { pricing: model.pricing } : {}),
  };
};

const geminiError = (status: number, message: string): Response =>
  Response.json(
    { error: { code: status, message, status: geminiStatusForHttpStatus(status) } },
    { status: status as 400 | 404 | 500 | 502 },
  );

const geminiModelLoadError = (error: unknown): Response => {
  if (error instanceof ProviderModelsUnavailableError) {
    return geminiError(502, MODEL_LISTING_FAILURE_MESSAGE);
  }
  return geminiError(502, error instanceof Error ? error.message : String(error));
};

// Real chat models plus chat-kind alias entries; collision and dedupe ride
// on the shared `mergeAliasesIntoModels` helper so /v1beta/models stays in
// step with /v1/models and the dashboard's /api/models.
const loadGeminiModels = async (
  upstreamFilter: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
  aliasRepo: ModelAliasesRepo,
): Promise<GeminiModel[]> => {
  const [callerAddressable, gatewayAddressable, aliases] = await Promise.all([
    enumerateAddressableModelIds(upstreamFilter, fetcherForUpstream, scheduler),
    upstreamFilter === null
      ? Promise.resolve(null)
      : enumerateAddressableModelIds(null, fetcherForUpstream, scheduler),
    aliasRepo.list(),
  ]);
  const gatewayAddressableModelIds = gatewayAddressable ?? callerAddressable;
  const realModels = listedRealModels(callerAddressable);
  // Gemini surfaces chat-kind models only; filter both the real catalog and
  // the synthesized alias entries before the merge so the alias collision
  // step only ever weighs chat-on-chat.
  const merged = mergeAliasesIntoModels({
    realModels: realModels.filter(model => model.kind === 'chat'),
    gatewayAddressableModelIds: gatewayAddressableModelIds.filter(entry => entry.model.kind === 'chat'),
    callerAddressableModelIds: callerAddressable.filter(entry => entry.model.kind === 'chat'),
    aliases: aliases.filter(alias => alias.kind === 'chat'),
    narrowTargets: true,
  });
  return merged.map(toGeminiModel);
};

export const serveGeminiModels = async (c: Context): Promise<Response> => {
  try {
    const fetcherForUpstream = await createPerRequestFetcher(getRuntimeLocation(c.req.raw));
    return Response.json({ models: await loadGeminiModels(effectiveUpstreamIdsFromContext(c), fetcherForUpstream, backgroundSchedulerFromContext(c), getRepo().modelAliases) });
  } catch (error) {
    return geminiModelLoadError(error);
  }
};

export const serveGeminiModelInfo = async (c: Context): Promise<Response> => {
  const rawModelId = c.req.param('modelId');
  if (!rawModelId) return geminiError(404, 'Model not found: ');

  const modelId = rawModelId.replace(/^models\//, '');
  try {
    const fetcherForUpstream = await createPerRequestFetcher(getRuntimeLocation(c.req.raw));
    const model = (await loadGeminiModels(effectiveUpstreamIdsFromContext(c), fetcherForUpstream, backgroundSchedulerFromContext(c), getRepo().modelAliases)).find(candidate => candidate.baseModelId === modelId || candidate.name === `models/${modelId}`);
    if (!model) return geminiError(404, `Model not found: ${modelId}`);
    return Response.json(model);
  } catch (error) {
    return geminiModelLoadError(error);
  }
};
