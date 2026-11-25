import { azureOpenAIImagesUrl } from '../../endpoint.ts';
import { azureOperation, openAIError } from '../dial.ts';
import { parseJsonObject } from '../parse-json-object.ts';
import { decodeOpenAIImagesEditsStream } from '@floway-dev/protocols/openai-images';
import { parseHttpResponse, serializeOpenAIImagesEditsBody } from '@floway-dev/provider';

export const openaiImagesEdits = azureOperation('openaiImagesEdits', {
  parse: parseHttpResponse('openaiImagesEdits', {
    select: payload => payload.parameters.stream === true || payload.parameters.stream === 'true' ? 'stream' : 'result',
    stream: decodeOpenAIImagesEditsStream,
    result: parseJsonObject,
    format: openAIError,
  }),
  prepare: async (payload, model, endpoint) => ({
    url: azureOpenAIImagesUrl(endpoint, '/images/edits'),
    ...await serializeOpenAIImagesEditsBody(payload, model.upstreamModelId),
  }),
});
