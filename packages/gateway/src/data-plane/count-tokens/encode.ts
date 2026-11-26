import { encode, encodedResponse, jsonResponse, localResponseHead } from '../pipeline/encode.ts';

export const encodeAnthropicMessagesCountTokens = encode('anthropicMessagesCountTokens', ({ http, outcome }) => {
  if (outcome.kind === 'error') {
    return jsonResponse(http ?? localResponseHead(outcome.source === 'upstream' ? 502 : 499), outcome.error);
  }
  if (http === null) throw new Error('Anthropic Messages count_tokens result requires an HTTP response');
  return outcome.result === null ? encodedResponse(http, null) : jsonResponse(http, outcome.result);
});

export const encodeGeminiGenerateContentCountTokens = encode('geminiGenerateContentCountTokens', ({ http, outcome }) => {
  if (outcome.kind === 'error') {
    return jsonResponse(http ?? localResponseHead(outcome.source === 'upstream' ? 502 : 499), outcome.error);
  }
  if (http === null) throw new Error('Gemini countTokens result requires an HTTP response');
  return outcome.result === null ? encodedResponse(http, null) : jsonResponse(http, outcome.result);
});
