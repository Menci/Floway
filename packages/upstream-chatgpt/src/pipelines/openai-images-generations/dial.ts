import { CHATGPT_OPENAI_IMAGES_GENERATIONS_PATH } from '../../constants.ts';
import { dialChatGPT, dialResponseConsumes, dialResponseNeeds, formatError, HTTP_ERROR_BODY_BYTES, IMAGE_RESULT_BODY_BYTES, parseObject } from '../dial.ts';
import { defineStage } from '../facts.ts';
import { imageRequest, incomingHeaders } from '../request.ts';
import { decodeOpenAIImagesGenerationsStream } from '@floway-dev/protocols/openai-images';
import { parseUpstreamResult, parseUpstreamStream } from '@floway-dev/upstream';

export const openAIImagesGenerationsDial = defineStage({
  name: 'chatgpt.openaiImagesGenerations.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiImagesGenerations'], provides: ['http'], consumes: [] },
    response: { needs: dialResponseNeeds, consumes: dialResponseConsumes, provides: ['http', 'openaiImagesGenerations'] },
  },
  return: { provides: ['http', 'openaiImagesGenerations'] },
  async execute(facts, scope) {
    const { http, upstream, model, openaiImagesGenerations } = facts;
    const dialed = await dialChatGPT(scope, {
      upstream,
      images: true,
      prepare: () => ({
        request: imageRequest(CHATGPT_OPENAI_IMAGES_GENERATIONS_PATH, { ...openaiImagesGenerations, model: model.id }, incomingHeaders(http.headers)),
      }),
      next: (_, request) => scope.next({ ...facts, http: request }),
    });
    if (dialed.kind === 'error') return { http: dialed.http, openaiImagesGenerations: dialed.outcome };
    const parsed = openaiImagesGenerations.stream === true
      ? await parseUpstreamStream(dialed.http, scope, decodeOpenAIImagesGenerationsStream, formatError, HTTP_ERROR_BODY_BYTES)
      : await parseUpstreamResult(dialed.http, scope, parseObject, formatError,
          { maxResultBodyBytes: IMAGE_RESULT_BODY_BYTES, maxErrorBodyBytes: HTTP_ERROR_BODY_BYTES });
    return { http: parsed.http, openaiImagesGenerations: parsed.outcome };
  },
});
