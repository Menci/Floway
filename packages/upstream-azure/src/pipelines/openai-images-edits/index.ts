import { readAzureUpstreamConfig } from '../../config.ts';
import { azureOpenAIImagesUrl } from '../../endpoint.ts';
import { compose, defineStage } from '../fact-space.ts';
import { filterAzureHeaders } from '../filter-headers.ts';
import { azureRequest, decodeJsonObject, MAX_AZURE_IMAGE_RESULT_BODY_BYTES, parseAzureStreamOrResult } from '../http.ts';
import { decodeOpenAIImagesEditsStream } from '@floway-dev/protocols/openai-images';
import { httpTerminal, serializeOpenAIImagesEditsBody } from '@floway-dev/upstream';

const dial = defineStage({
  name: 'azure.openaiImagesEdits.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'openaiImagesEdits'], provides: ['http'], consumes: [] },
    response: { needs: ['http', 'http.error?'], provides: ['http', 'openaiImagesEdits'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { endpoint, apiKey } = readAzureUpstreamConfig(facts.upstream);
    const url = azureOpenAIImagesUrl(endpoint, '/images/edits');
    const body = await serializeOpenAIImagesEditsBody(facts.openaiImagesEdits, facts.model.upstreamModelId);
    const httpRequest = azureRequest(facts.http, url, apiKey, body);
    const { 'http.error': failure, ...answer } = await scope.next({ ...facts, http: httpRequest });
    const parsed = await parseAzureStreamOrResult(answer.http, failure, scope, decodeOpenAIImagesEditsStream, decodeJsonObject, MAX_AZURE_IMAGE_RESULT_BODY_BYTES);
    return { ...answer, http: parsed.http, openaiImagesEdits: parsed.outcome };
  },
});

export const azureOpenAIImagesEditsPipeline = compose('azure.openaiImagesEdits', {
  entry: ['http', 'upstream', 'model', 'openaiImagesEdits'],
  exit: ['http', 'openaiImagesEdits'],
  stages: [filterAzureHeaders, dial],
  ending: httpTerminal,
});
