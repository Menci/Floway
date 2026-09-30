import type { AzureUpstreamConfig } from '../config.ts';
import { azureAnthropicBaseUrl, azureOpenAiV1BaseUrl } from '../endpoint.ts';
import { type HttpRequestFacts } from '@floway-dev/http/pipeline';
import { multipartBody, type HttpBody, type HttpBodyEncoding } from '@floway-dev/http/request-content';
import { defineStage, move, secret } from '@floway-dev/pipeline';
import { toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';
import { joinBaseAndPath, mergeHttpHeaders, prepareOpenAIImagesEditsBody, withHttpContentType, type ProviderOperationPayloads, type ProviderRequest, type ProviderResponse, type ProviderServices } from '@floway-dev/provider';

type AzureOperation = 'openaiChatCompletions' | 'openaiResponses' | 'openaiResponsesCompact' | 'anthropicMessages' | 'anthropicMessagesCountTokens' | 'openaiCompletions' | 'openaiEmbeddings' | 'openaiImagesGenerations' | 'openaiImagesEdits' | 'openaiAudioTranscriptions';

interface AzureHttpFacts extends HttpRequestFacts {
  'request.provider.modelKey': string;
  'request.azure.deployment': string;
}

const PATHS: Record<Exclude<AzureOperation, 'openaiAudioTranscriptions'>, string> = {
  openaiChatCompletions: '/chat/completions',
  openaiResponses: '/responses',
  openaiResponsesCompact: '/responses/compact',
  anthropicMessages: '/v1/messages',
  anthropicMessagesCountTokens: '/v1/messages/count_tokens',
  openaiCompletions: '/completions',
  openaiEmbeddings: '/embeddings',
  openaiImagesGenerations: '/images/generations',
  openaiImagesEdits: '/images/edits',
};

export const prepareAzureRequest = <O extends AzureOperation>(config: AzureUpstreamConfig, operation: O) => {
  const prepare = defineStage<ProviderRequest<ProviderOperationPayloads[O]> & { 'request.provider.anthropicBeta'?: readonly string[]; 'request.provider.responsesAction': 'generate' | 'compact' }, AzureHttpFacts, ProviderResponse, ProviderResponse, ProviderServices>({
    name: `prepareAzure${operation.replace(/^openai/, 'OpenAI').replace(/^alpha/, 'Alpha').replace(/^rerank/, 'Rerank')}`,
    through: {
      request: {
        needs: [...(operation === 'openaiResponses' || operation === 'openaiResponsesCompact' ? ['request.provider.responsesAction' as const] : []), 'request.provider.model', 'request.provider.payload', 'request.http.callId', 'request.http.headers', ...(operation === 'anthropicMessages' || operation === 'anthropicMessagesCountTokens' ? ['request.provider.anthropicBeta' as const] : [])],
        consumes: ['request.provider.model', 'request.provider.payload', 'request.http.headers'],
        provides: ['request.http.url', 'request.http.method', 'request.http.headers', 'request.http.body', 'request.http.encoding', 'request.provider.modelKey', 'request.azure.deployment'],
      },
      response: { needs: [], consumes: [], provides: [] },
    },
    execute: async (facts, next) => {
      const { 'request.provider.model': model, 'request.provider.payload': payload, ...rest } = facts;
      const deployment = (model.providerData as { upstreamModelId: string }).upstreamModelId;
      const anthropic = operation === 'anthropicMessages' || operation === 'anthropicMessagesCountTokens';
      let body: HttpBody;
      let encoding: HttpBodyEncoding = 'json';
      let url: URL;
      if (operation === 'openaiAudioTranscriptions') {
        body = multipartBody((payload as ProviderOperationPayloads['openaiAudioTranscriptions']).entries.filter(entry => entry.name !== 'model'));
        encoding = 'multipart';
        url = new URL(config.endpoint);
        url.pathname = `/openai/deployments/${encodeURIComponent(deployment)}/audio/transcriptions`;
        url.search = '';
        url.hash = '';
        // https://github.com/Azure/azure-rest-api-specs/blob/928047803788f7377fa003a26ba2bdc2e0fcccc0/specification/cognitiveservices/OpenAI.Inference/routes/audio_transcription.tsp#L19-L49
        url.searchParams.set('api-version', '2025-04-01-preview');
      } else {
        const baseUrl = anthropic ? azureAnthropicBaseUrl(config.endpoint) : azureOpenAiV1BaseUrl(config.endpoint);
        const path = operation === 'openaiResponses' || operation === 'openaiResponsesCompact'
          ? PATHS[facts['request.provider.responsesAction'] === 'compact' ? 'openaiResponsesCompact' : 'openaiResponses']
          : PATHS[operation as Exclude<AzureOperation, 'openaiAudioTranscriptions'>];
        url = new URL(joinBaseAndPath(baseUrl, path));
        if (operation === 'openaiImagesEdits') {
          const prepared = await prepareOpenAIImagesEditsBody(payload as ProviderOperationPayloads['openaiImagesEdits'], deployment);
          body = prepared.body;
          encoding = prepared.encoding;
        } else {
          body = (operation === 'openaiResponses' || operation === 'openaiResponsesCompact') && facts['request.provider.responsesAction'] === 'compact'
            ? { ...toCompactPayloadShape(payload as ProviderOperationPayloads['openaiResponsesCompact']), model: deployment }
            : { ...payload, ...(operation === 'openaiChatCompletions' || operation === 'openaiResponses' || operation === 'openaiResponsesCompact' || operation === 'anthropicMessages' ? { stream: true } : {}), model: deployment };
        }
        if (operation === 'openaiImagesGenerations' || operation === 'openaiImagesEdits') url.searchParams.append('api-version', 'preview');
      }
      // https://learn.microsoft.com/en-us/azure/ai-foundry/foundry-models/how-to/use-foundry-models
      // https://docs.anthropic.com/en/api/versioning
      const base = withHttpContentType(anthropic ? [['x-api-key', secret(config.apiKey)], ['anthropic-version', '2023-06-01']] : [['api-key', secret(config.apiKey)]], body, encoding);
      let headers = mergeHttpHeaders(base, facts['request.http.headers']);
      if (anthropic) {
        const beta = facts['request.provider.anthropicBeta'] as readonly string[];
        headers = headers.filter(([name]) => name.toLowerCase() !== 'anthropic-beta');
        if (beta.length > 0) headers = [...headers, ['anthropic-beta', beta.join(',')]];
      }
      const back = await next(move({
        ...rest,
        'request.provider.modelKey': deployment,
        'request.azure.deployment': deployment,
        'request.http.url': url.href,
        'request.http.method': 'POST',
        'request.http.headers': headers,
        'request.http.body': body,
        'request.http.encoding': encoding,
      }));
      return move({ ...back });
    },
  });
  return prepare;
};
