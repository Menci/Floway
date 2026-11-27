import { IMAGE_RESULT_BODY_BYTES, customModelRequest, customResult, customStream, decodeJsonObject, defineStage, dialResponseConsumes, dialResponseNeeds } from '../http.ts';
import { decodeOpenAIImagesGenerationsStream } from '@floway-dev/protocols/openai-images';

export const openaiImagesGenerationsDial = defineStage({
  name: 'custom.openaiImagesGenerations.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiImagesGenerations'], provides: ['http'], consumes: [] },
    response: { needs: dialResponseNeeds, provides: ['http', 'openaiImagesGenerations'], consumes: dialResponseConsumes },
  },
  async execute(facts, scope) {
    const { http, upstream, model, openaiImagesGenerations } = facts;
    const request = customModelRequest(http, upstream, '/images/generations', model.upstreamModelId, openaiImagesGenerations);
    const answer = await scope.next({ ...facts, http: request });
    const parsed = openaiImagesGenerations.stream === true
      ? await customStream(answer, scope, decodeOpenAIImagesGenerationsStream)
      : await customResult(answer, scope, decodeJsonObject, IMAGE_RESULT_BODY_BYTES);
    return { http: parsed.http, openaiImagesGenerations: parsed.outcome };
  },
});
