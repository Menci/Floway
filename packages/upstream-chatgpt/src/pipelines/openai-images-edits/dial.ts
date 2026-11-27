import { CHATGPT_OPENAI_IMAGES_EDITS_PATH } from '../../constants.ts';
import { dialChatGPT, dialResponseConsumes, dialResponseNeeds, formatError, HTTP_ERROR_BODY_BYTES, IMAGE_RESULT_BODY_BYTES, parseObject } from '../dial.ts';
import { defineStage } from '../facts.ts';
import { imageRequest, incomingHeaders } from '../request.ts';
import { decodeOpenAIImagesEditsStream } from '@floway-dev/protocols/openai-images';
import { parseUpstreamResult, parseUpstreamStream, serializeOpenAIImagesEditsJsonPayload } from '@floway-dev/upstream';

export const openAIImagesEditsDial = defineStage({
  name: 'chatgpt.openaiImagesEdits.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiImagesEdits'], provides: ['http'], consumes: [] },
    response: { needs: dialResponseNeeds, consumes: dialResponseConsumes, provides: ['http', 'openaiImagesEdits'] },
  },
  return: { provides: ['http', 'openaiImagesEdits'] },
  async execute(facts, scope) {
    const { http, upstream, model, openaiImagesEdits } = facts;
    const dialed = await dialChatGPT(scope, {
      upstream,
      images: true,
      async prepare() {
        const payload = await serializeOpenAIImagesEditsJsonPayload(openaiImagesEdits, model.id);
        return { request: imageRequest(CHATGPT_OPENAI_IMAGES_EDITS_PATH, payload, incomingHeaders(http.headers)) };
      },
      next: (_, request) => scope.next({ ...facts, http: request }),
    });
    if (dialed.kind === 'error') return { http: dialed.http, openaiImagesEdits: dialed.outcome };
    const stream = openaiImagesEdits.parameters.stream;
    const parsed = stream === true || stream === 'true'
      ? await parseUpstreamStream(dialed.http, scope, decodeOpenAIImagesEditsStream, formatError, HTTP_ERROR_BODY_BYTES)
      : await parseUpstreamResult(dialed.http, scope, parseObject, formatError,
          { maxResultBodyBytes: IMAGE_RESULT_BODY_BYTES, maxErrorBodyBytes: HTTP_ERROR_BODY_BYTES });
    return { http: parsed.http, openaiImagesEdits: parsed.outcome };
  },
});
