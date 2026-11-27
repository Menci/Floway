import { pathOverrideFor } from '../../endpoints.ts';
import { IMAGE_RESULT_BODY_BYTES, customConfig, customRequest, customResult, customStream, decodeJsonObject, defineStage, dialResponseConsumes, dialResponseNeeds } from '../http.ts';
import { decodeOpenAIImagesEditsStream } from '@floway-dev/protocols/openai-images';
import { serializeOpenAIImagesEditsBody } from '@floway-dev/upstream';

export const openaiImagesEditsDial = defineStage({
  name: 'custom.openaiImagesEdits.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiImagesEdits'], provides: ['http'], consumes: [] },
    response: { needs: dialResponseNeeds, provides: ['http', 'openaiImagesEdits'], consumes: dialResponseConsumes },
  },
  async execute(facts, scope) {
    const { http, upstream, model, openaiImagesEdits } = facts;
    const config = customConfig(upstream);
    const content = await serializeOpenAIImagesEditsBody(openaiImagesEdits, model.upstreamModelId);
    const request = customRequest(http, config, pathOverrideFor(config, '/images/edits'), content);
    const answer = await scope.next({ ...facts, http: request });
    const parsed = openaiImagesEdits.parameters.stream === true || openaiImagesEdits.parameters.stream === 'true'
      ? await customStream(answer, scope, decodeOpenAIImagesEditsStream)
      : await customResult(answer, scope, decodeJsonObject, IMAGE_RESULT_BODY_BYTES);
    return { http: parsed.http, openaiImagesEdits: parsed.outcome };
  },
});
