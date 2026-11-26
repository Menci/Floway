import { selectCopilotRawModel } from '../../model-selection.ts';
import { rewritePayload } from '../shared/rewrite-payload.ts';

export const selectModel = rewritePayload('openaiEmbeddings', 'selectModel', (payload, model) => ({
  ...payload, model: selectCopilotRawModel(model, 'openaiEmbeddings'),
}));
