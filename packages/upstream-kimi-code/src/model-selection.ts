import { object, string } from './validation.ts';
import type { Result } from '@floway-dev/pipeline';
import { FAST_SERVICE_TIER, isFastServiceTier } from '@floway-dev/protocols/common';
import type { UpstreamModel } from '@floway-dev/upstream';

export interface KimiCodeUpstreamData {
  standardModelId?: string;
  fastModelId?: string;
}

type KimiCodeModel = Pick<UpstreamModel, 'id' | 'upstreamData'>;
export type KimiCodeOpenAITier = typeof FAST_SERVICE_TIER | 'default';
export type KimiCodeMessagesSpeed = 'fast' | 'standard';

const selectKimiCodeModel = (model: KimiCodeModel, fast: boolean): { modelId: string; lane: 'fast' | 'standard' } | undefined => {
  const lanes = object(model.upstreamData, `Kimi Code model ${model.id} lanes`);
  if (fast && lanes.fastModelId !== undefined) return { modelId: string(lanes.fastModelId, 'Kimi Code fast model id'), lane: 'fast' };
  return lanes.standardModelId === undefined ? undefined : { modelId: string(lanes.standardModelId, 'Kimi Code standard model id'), lane: 'standard' };
};

// Kimi's catalog distinguishes an alternate fast lane from a fast-only family.
// OpenAI permits a standard-speed response carrying the selected tier.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
// https://developers.openai.com/api/docs/guides/priority-processing
export const selectKimiCodeOpenAIModel = (model: KimiCodeModel, requestedTier: string | null | undefined): Result<{ modelId: string; tier?: KimiCodeOpenAITier }, string> => {
  const fast = isFastServiceTier(requestedTier);
  const selection = selectKimiCodeModel(model, fast);
  if (selection === undefined) {
    return { ok: false, error: `'${model.id}' is only available with fast mode selected; set \`service_tier: "${FAST_SERVICE_TIER}"\`.` };
  }
  return {
    ok: true,
    value: { modelId: selection.modelId, ...(fast && { tier: selection.lane === 'fast' ? FAST_SERVICE_TIER : 'default' }) },
  };
};

// Anthropic rejects fast requests on unsupported models.
// https://platform.claude.com/docs/en/build-with-claude/fast-mode
export const selectKimiCodeMessagesModel = (model: KimiCodeModel, requestedSpeed: unknown): Result<{ modelId: string; speed?: KimiCodeMessagesSpeed }, string> => {
  const selection = selectKimiCodeModel(model, requestedSpeed === 'fast');
  if (requestedSpeed === 'fast' && selection?.lane !== 'fast') {
    return { ok: false, error: `'${model.id}' does not support fast mode; omit \`speed\` or set \`speed: "standard"\`.` };
  }
  if (selection === undefined) {
    return { ok: false, error: `'${model.id}' is only available with fast mode selected; set \`speed: "fast"\`.` };
  }
  return {
    ok: true,
    value: { modelId: selection.modelId, ...(requestedSpeed === 'fast' || requestedSpeed === 'standard' ? { speed: requestedSpeed } : {}) },
  };
};
