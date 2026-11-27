import { geminiGenerateContentUrl, bareGeminiModelId } from '../../endpoints.ts';
import { COUNT_RESULT_BODY_BYTES, customConfig, customJsonRequest, customResult, decodeJson, defineStage, dialResponseConsumes, dialResponseNeeds, nullableCountResult } from '../http.ts';
import { decodeGeminiGenerateContentCountTokensResult, type GeminiGenerateContentCountTokensPayload } from '@floway-dev/protocols/gemini-generate-content';

export const geminiGenerateContentCountTokensDial = defineStage({
  name: 'custom.geminiGenerateContentCountTokens.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'geminiGenerateContentCountTokens'], provides: ['http'], consumes: [] },
    response: { needs: dialResponseNeeds, provides: ['http', 'geminiGenerateContentCountTokens'], consumes: dialResponseConsumes },
  },
  async execute(facts, scope) {
    const { http, upstream, model, geminiGenerateContentCountTokens } = facts;
    const config = customConfig(upstream);
    const modelId = bareGeminiModelId(model.upstreamModelId);
    const url = geminiGenerateContentUrl(config, modelId, 'countTokens');
    const request = customJsonRequest(http, config, url, geminiCountTokensBody(geminiGenerateContentCountTokens, modelId), 'x-goog-api-key');
    const answer = await scope.next({ ...facts, http: request });
    const parsed = await customResult(answer, scope, nullableCountResult(decodeJson(decodeGeminiGenerateContentCountTokensResult)), COUNT_RESULT_BODY_BYTES, 'x-goog-api-key');
    return { http: parsed.http, geminiGenerateContentCountTokens: parsed.outcome };
  },
});

// The full request includes system instructions, tools, and generation configuration in the count.
// https://ai.google.dev/api/tokens#method:-models.counttokens
const geminiCountTokensBody = ({ contents, generateContentRequest }: GeminiGenerateContentCountTokensPayload, modelId: string): GeminiGenerateContentCountTokensPayload => {
  const model = `models/${modelId}`;
  if (generateContentRequest !== undefined) return { generateContentRequest: { ...generateContentRequest, model } };
  if (contents === undefined) throw new Error('Gemini countTokens requires contents or generateContentRequest');
  return { generateContentRequest: { contents, model } };
};
