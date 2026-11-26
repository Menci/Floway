import { selectCopilotRawModel } from '../../model-selection.ts';
import { rewritePayload } from '../shared/rewrite-payload.ts';
import { isFastServiceTier } from '@floway-dev/protocols/common';

export const selectModel = rewritePayload('openaiResponsesCompact', 'selectModel', (payload, model) => ({
  ...payload,
  model: selectCopilotRawModel(model, 'openaiResponses', { fast: isFastServiceTier(payload.service_tier) }),
}));
