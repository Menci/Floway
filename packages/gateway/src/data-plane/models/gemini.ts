import { loadModelListingCatalog } from './load.ts';
import { createModelsRefreshScheduler, type ModelsRefreshScheduler } from '../../execution/models-refresh.ts';
import { type AuthedContext, effectiveUpstreamIdsFromContext, userFromContext } from '../../middleware/auth.ts';
import { getRepo } from '../../repo/index.ts';
import type { ModelAliasesRepo, User } from '../../repo/types.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getRuntimeLocation } from '../../runtime/runtime-info.ts';
import { geminiGenerateContentErrorResponse } from '../chat/gemini-generate-content/errors.ts';
import { mergeAliasesIntoModels } from '../shared/listing/alias.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';
import type { InternalModel } from '@floway-dev/provider';

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

const geminiModelLoadError = (error: unknown): Response =>
  geminiGenerateContentErrorResponse(502, error instanceof Error ? error.message : String(error));

// Real chat models plus chat-kind alias entries; collision and dedupe ride
// on the shared `mergeAliasesIntoModels` helper so the Gemini listing stays in
// step with the OpenAI listing and the dashboard's /api/models.
const loadGeminiModels = async (
  subject: User,
  upstreamFilter: readonly string[] | null,
  scheduleRefresh: ModelsRefreshScheduler,
  aliasRepo: ModelAliasesRepo,
): Promise<GeminiModel[]> => {
  const { callerAddressable, gatewayAddressable, realModels, aliases } = await loadModelListingCatalog(subject, upstreamFilter, scheduleRefresh, aliasRepo);
  // Gemini surfaces chat-kind models only; filter both the real catalog and
  // the synthesized alias entries before the merge so the alias collision
  // step only ever weighs chat-on-chat.
  const merged = mergeAliasesIntoModels({
    realModels: realModels.filter(model => model.kind === 'chat'),
    gatewayAddressableModelIds: gatewayAddressable.filter(entry => entry.model.kind === 'chat'),
    callerAddressableModelIds: callerAddressable.filter(entry => entry.model.kind === 'chat'),
    aliases: aliases.filter(alias => alias.kind === 'chat'),
    narrowTargets: true,
  });
  return merged.map(toGeminiModel);
};

// Reached from the shared model-list handler when the caller identifies as a
// Gemini client; the route paths themselves carry no protocol meaning.
export const serveGeminiModels = async (c: AuthedContext): Promise<Response> => {
  try {
    const scheduleRefresh = createModelsRefreshScheduler(getRuntimeLocation(c.req.raw), backgroundSchedulerFromContext(c));
    return Response.json({ models: await loadGeminiModels(userFromContext(c), effectiveUpstreamIdsFromContext(c), scheduleRefresh, getRepo().modelAliases) });
  } catch (error) {
    return geminiModelLoadError(error);
  }
};

export const serveGeminiModelInfo = async (c: AuthedContext): Promise<Response> => {
  const rawModelId = c.req.param('modelId');
  if (!rawModelId) return geminiGenerateContentErrorResponse(404, 'Model not found: ');

  const modelId = rawModelId.replace(/^models\//, '');
  try {
    const scheduleRefresh = createModelsRefreshScheduler(getRuntimeLocation(c.req.raw), backgroundSchedulerFromContext(c));
    const model = (await loadGeminiModels(userFromContext(c), effectiveUpstreamIdsFromContext(c), scheduleRefresh, getRepo().modelAliases)).find(candidate => candidate.baseModelId === modelId || candidate.name === `models/${modelId}`);
    if (!model) return geminiGenerateContentErrorResponse(404, `Model not found: ${modelId}`);
    return Response.json(model);
  } catch (error) {
    return geminiModelLoadError(error);
  }
};
