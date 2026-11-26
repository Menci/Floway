import { rewritePayload } from '../shared/rewrite-payload.ts';

// Copilot requires text input as an array, even for one string.
// https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/services/copilot/create-embeddings.ts#L19-L21
export const wrapScalarInput = rewritePayload('openaiEmbeddings', 'wrapScalarInput', payload =>
  typeof payload.input === 'string' ? { ...payload, input: [payload.input] } : payload);
