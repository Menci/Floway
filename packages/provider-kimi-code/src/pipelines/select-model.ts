import { selectKimiCodeModel } from '../model-selection.ts';
import type { HttpResponseFact } from '@floway-dev/http';
import type { Result } from '@floway-dev/pipeline';
import { FAST_SERVICE_TIER, isFastServiceTier } from '@floway-dev/protocols/common';
import type { ProtocolError, ProviderModelFact } from '@floway-dev/provider';

type SelectedOpenAIModel = { modelId: string; tier?: typeof FAST_SERVICE_TIER | 'default' };
type SelectedAnthropicModel = { modelId: string; speed?: 'fast' | 'standard' };

// https://www.kimi.com/code/docs/en/kimi-code/models.html
// https://developers.openai.com/api/docs/guides/priority-processing
export const selectOpenAIModel = (model: ProviderModelFact, serviceTier: string | null | undefined): Result<SelectedOpenAIModel, string> => {
  const fast = isFastServiceTier(serviceTier);
  const selection = selectKimiCodeModel(model, fast);
  if (selection === undefined) {
    return { ok: false, error: `'${model.id}' is only available with fast mode selected; set \`service_tier: "${FAST_SERVICE_TIER}"\`.` };
  }
  return {
    ok: true,
    value: { modelId: selection.modelId, ...(fast && { tier: selection.lane === 'fast' ? FAST_SERVICE_TIER : 'default' }) },
  };
};

// https://www.kimi.com/code/docs/en/kimi-code/models.html
// https://platform.claude.com/docs/en/build-with-claude/fast-mode
export const selectAnthropicModel = (model: ProviderModelFact, speed: unknown): Result<SelectedAnthropicModel, string> => {
  const selection = selectKimiCodeModel(model, speed === 'fast');
  if (speed === 'fast' && selection?.lane !== 'fast') {
    return { ok: false, error: `'${model.id}' does not support fast mode; omit \`speed\` or set \`speed: "standard"\`.` };
  }
  if (selection === undefined) {
    return { ok: false, error: `'${model.id}' is only available with fast mode selected; set \`speed: "fast"\`.` };
  }
  return { ok: true, value: { modelId: selection.modelId, ...(speed === 'fast' || speed === 'standard' ? { speed } : {}) } };
};

export const invalidModel = (message: string, anthropic: boolean): { http: HttpResponseFact; outcome: ProtocolError } => ({
  http: { status: 400, statusText: '', headers: [['content-type', 'application/json']], body: null },
  outcome: {
    kind: 'error',
    source: 'local',
    error: { ...(anthropic && { type: 'error' }), error: { type: 'invalid_request_error', message } },
  },
});
