import { geminiGenerateContentUrl, bareGeminiModelId } from '../../endpoints.ts';
import { customConfig, customJsonRequest, customStream, defineStage, dialResponseConsumes, dialResponseNeeds } from '../http.ts';
import { decodeGeminiGenerateContentStream } from '@floway-dev/protocols/gemini-generate-content';

export const geminiGenerateContentDial = defineStage({
  name: 'custom.geminiGenerateContent.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'geminiGenerateContent'], provides: ['http'], consumes: [] },
    response: { needs: dialResponseNeeds, provides: ['http', 'geminiGenerateContent'], consumes: dialResponseConsumes },
  },
  async execute(facts, scope) {
    const { http, upstream, model, geminiGenerateContent } = facts;
    const config = customConfig(upstream);
    const url = geminiGenerateContentUrl(config, bareGeminiModelId(model.upstreamModelId), 'streamGenerateContent');
    const request = customJsonRequest(http, config, url, geminiGenerateContent, 'x-goog-api-key');
    const answer = await scope.next({ ...facts, http: request });
    const parsed = await customStream(answer, scope, decodeGeminiGenerateContentStream, 'x-goog-api-key');
    return { http: parsed.http, geminiGenerateContent: parsed.outcome };
  },
});
