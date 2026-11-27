import { readAzureUpstreamConfig } from '../../config.ts';
import { azureAnthropicMessagesUrl } from '../../endpoint.ts';
import { compose, defineStage } from '../fact-space.ts';
import { filterAzureAnthropicHeaders } from '../filter-anthropic-headers.ts';
import { azureRequest, anthropicError, decodeJsonBody, jsonBody, parseAzureResult } from '../http.ts';
import type { Result } from '@floway-dev/pipeline';
import { decodeAnthropicMessagesCountTokensResult, type AnthropicMessagesCountTokensResult } from '@floway-dev/protocols/anthropic-messages';
import { httpTerminal } from '@floway-dev/upstream';

const decodeResult = (bytes: Uint8Array, { status }: { status: number }): Result<AnthropicMessagesCountTokensResult | null, Error> =>
  status === 204 || status === 205
    ? { ok: true, value: null }
    : decodeJsonBody(bytes, decodeAnthropicMessagesCountTokensResult);

const dial = defineStage({
  name: 'azure.anthropicMessagesCountTokens.dial',
  through: {
    request: { needs: ['http', 'upstream', 'model', 'anthropicMessagesCountTokens'], provides: ['http'], consumes: [] },
    response: { needs: ['http', 'http.error?'], provides: ['http', 'anthropicMessagesCountTokens'], consumes: ['http.error'] },
  },
  async execute(facts, scope) {
    const { endpoint, apiKey } = readAzureUpstreamConfig(facts.upstream);
    const url = azureAnthropicMessagesUrl(endpoint, '/v1/messages/count_tokens');
    const body = jsonBody({ ...facts.anthropicMessagesCountTokens, model: facts.model.upstreamModelId });
    const httpRequest = azureRequest(facts.http, url, apiKey, body, 'anthropic');
    const { 'http.error': failure, ...answer } = await scope.next({ ...facts, http: httpRequest });
    const parsed = await parseAzureResult(answer.http, failure, scope, decodeResult, anthropicError);
    return { ...answer, http: parsed.http, anthropicMessagesCountTokens: parsed.outcome };
  },
});

export const azureAnthropicMessagesCountTokensPipeline = compose('azure.anthropicMessagesCountTokens', {
  entry: ['http', 'upstream', 'model', 'anthropicMessagesCountTokens'],
  exit: ['http', 'anthropicMessagesCountTokens'],
  stages: [filterAzureAnthropicHeaders, dial],
  ending: httpTerminal,
});
