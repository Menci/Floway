import { EMBEDDINGS_RESULT_BODY_BYTES, customModelRequest, customResult, decodeJsonObject, defineStage, dialResponseConsumes, dialResponseNeeds } from '../http.ts';

export const openaiEmbeddingsDial = defineStage({
  name: 'custom.openaiEmbeddings.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiEmbeddings'], provides: ['http'], consumes: [] },
    response: { needs: dialResponseNeeds, provides: ['http', 'openaiEmbeddings'], consumes: dialResponseConsumes },
  },
  async execute(facts, scope) {
    const { http, upstream, model, openaiEmbeddings } = facts;
    const request = customModelRequest(http, upstream, '/embeddings', model.upstreamModelId, openaiEmbeddings);
    const answer = await scope.next({ ...facts, http: request });
    const parsed = await customResult(answer, scope, decodeJsonObject, EMBEDDINGS_RESULT_BODY_BYTES);
    return { http: parsed.http, openaiEmbeddings: parsed.outcome };
  },
});
