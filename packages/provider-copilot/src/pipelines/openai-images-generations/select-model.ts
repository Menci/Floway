import { selectCopilotRawModel } from '../../model-selection.ts';
import { rewritePayload } from '../shared/rewrite-payload.ts';

export const selectModel = rewritePayload('openaiImagesGenerations', 'selectModel', (payload, model) => ({
  ...payload, model: selectCopilotRawModel(model, 'openaiImagesGenerations'),
}));
