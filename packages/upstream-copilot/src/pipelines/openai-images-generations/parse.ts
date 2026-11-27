import { defineCopilotStage } from '../facts.ts';
import { formatOpenAIError } from '../shared/format-errors.ts';
import { ERROR_BODY_BYTES, IMAGE_RESULT_BODY_BYTES, readJsonObject } from '../shared/wire-request.ts';
import { getHeader } from '@floway-dev/http';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import { decodeOpenAIImagesGenerationsStream } from '@floway-dev/protocols/openai-images';
import { parseUpstreamResult, parseUpstreamStream } from '@floway-dev/upstream';

export const parse = defineCopilotStage({
  name: 'copilot.openaiImagesGenerations.parse',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: ['http', 'openaiImagesGenerations?'], provides: ['http', 'openaiImagesGenerations'], consumes: [] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const { http, openaiImagesGenerations: outcome } = back;
    if (outcome !== undefined) return { ...back, openaiImagesGenerations: outcome };
    if (http === null) throw new Error('Copilot openaiImagesGenerations has neither an HTTP response nor an outcome');
    const mediaType = getHeader(http.headers, 'content-type');
    const parsed = typeof mediaType === 'string' && isEventStreamMediaType(mediaType)
      ? await parseUpstreamStream(http, scope, decodeOpenAIImagesGenerationsStream, formatOpenAIError, ERROR_BODY_BYTES)
      : await parseUpstreamResult(http, scope, readJsonObject, formatOpenAIError, {
          maxResultBodyBytes: IMAGE_RESULT_BODY_BYTES,
          maxErrorBodyBytes: ERROR_BODY_BYTES,
        });
    return { ...back, http: parsed.http, openaiImagesGenerations: parsed.outcome };
  },
});
