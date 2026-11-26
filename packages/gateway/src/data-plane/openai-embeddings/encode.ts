import { encode, jsonResponse, localResponseHead } from '../pipeline/encode.ts';

export const encodeOpenAIEmbeddings = encode('openaiEmbeddings', ({ http, outcome }) => {
  if (outcome.kind === 'error') {
    return jsonResponse(http ?? localResponseHead(outcome.source === 'upstream' ? 502 : 499), outcome.error);
  }
  if (http === null) throw new Error('OpenAI Embeddings result requires an HTTP response');
  return jsonResponse(http, outcome.result);
});
