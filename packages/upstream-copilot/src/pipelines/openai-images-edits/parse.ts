import { defineCopilotStage } from '../facts.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { ERROR_BODY_BYTES, IMAGE_RESULT_BODY_BYTES, readJsonObject } from '../shared/wire-request.ts';
import { getHeader } from '@floway-dev/http';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import { decodeOpenAIImagesEditsStream } from '@floway-dev/protocols/openai-images';
import { parseUpstreamResult, parseUpstreamStream } from '@floway-dev/upstream';

export const parse = defineCopilotStage({
  name: 'copilot.openaiImagesEdits.parse',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['http', 'openaiImagesEdits?'], provides: ['http', 'openaiImagesEdits'], consumes: [] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const { http, openaiImagesEdits: outcome } = back;
    if (outcome !== undefined) return { ...back, openaiImagesEdits: outcome };
    if (http === null) throw new Error('Copilot openaiImagesEdits has neither an HTTP response nor an outcome');
    const mediaType = getHeader(http.headers, 'content-type');
    const parsed = typeof mediaType === 'string' && isEventStreamMediaType(mediaType)
      ? await parseUpstreamStream(http, scope, decodeOpenAIImagesEditsStream, formatOpenAIError, ERROR_BODY_BYTES)
      : await parseUpstreamResult(http, scope, readJsonObject, formatOpenAIError, {
          maxResultBodyBytes: IMAGE_RESULT_BODY_BYTES,
          maxErrorBodyBytes: ERROR_BODY_BYTES,
        });
    return { ...back, http: parsed.http, openaiImagesEdits: parsed.outcome };
  },
});
