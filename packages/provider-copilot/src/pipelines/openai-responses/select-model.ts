import { selectCopilotRawModel } from '../../model-selection.ts';
import { rewritePayload } from '../shared/rewrite-payload.ts';
import { isFastServiceTier } from '@floway-dev/protocols/common';

export const selectModel = rewritePayload('openaiResponses', 'selectModel', (payload, model) => {
  const effort = payload.reasoning?.effort;
  return {
    ...payload,
    model: selectCopilotRawModel(model, 'openaiResponses', {
      reasoningEffort: effort === 'none' ? undefined : effort ?? undefined,
      fast: isFastServiceTier(payload.service_tier),
    }),
  };
});
