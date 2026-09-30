import type { AzureUpstreamConfig } from '../config.ts';
import { azureOpenAiV1BaseUrl } from '../endpoint.ts';
import { type HttpRequestFacts, type HttpResponseFacts } from '@floway-dev/http/pipeline';
import { multipartBody, type HttpBody, type HttpBodyEncoding } from '@floway-dev/http/request-content';
import { defineStage, move, secret } from '@floway-dev/pipeline';
import { joinBaseAndPath, mergeHttpHeaders, prepareOpenAIImagesEditsBody, withHttpContentType, type ProviderOperationPayloads, type ProviderRequest, type ProviderResponse, type ProviderServices } from '@floway-dev/provider';

type AzureOperation = 'openaiCompletions' | 'openaiEmbeddings' | 'openaiImagesGenerations' | 'openaiImagesEdits' | 'openaiAudioTranscriptions';

interface AzureHttpFacts extends HttpRequestFacts {
  'request.azure.deployment': string;
}

const PATHS: Record<Exclude<AzureOperation, 'openaiAudioTranscriptions'>, string> = {
  openaiCompletions: '/completions',
  openaiEmbeddings: '/embeddings',
  openaiImagesGenerations: '/images/generations',
  openaiImagesEdits: '/images/edits',
};

export const prepareAzureRequest = <O extends AzureOperation>(config: AzureUpstreamConfig, operation: O) => {
  const prepare = defineStage<ProviderRequest<ProviderOperationPayloads[O]>, AzureHttpFacts, HttpResponseFacts, ProviderResponse, ProviderServices>({
    name: `prepareAzure${operation.replace(/^openai/, 'OpenAI').replace(/^alpha/, 'Alpha').replace(/^rerank/, 'Rerank')}`,
    through: {
      request: {
        needs: ['request.provider.model', 'request.provider.payload', 'request.http.callId', 'request.http.headers'],
        consumes: ['request.provider.model', 'request.provider.payload', 'request.http.headers'],
        provides: ['request.http.url', 'request.http.method', 'request.http.headers', 'request.http.body', 'request.http.encoding', 'request.azure.deployment'],
      },
      response: { needs: ['response.http.exchange'], consumes: [], provides: ['response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls'] },
    },
    execute: async (facts, next) => {
      const { 'request.provider.model': model, 'request.provider.payload': payload, ...rest } = facts;
      const deployment = (model.providerData as { upstreamModelId: string }).upstreamModelId;
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
        url = new URL(joinBaseAndPath(azureOpenAiV1BaseUrl(config.endpoint), PATHS[operation as Exclude<AzureOperation, 'openaiAudioTranscriptions'>]));
        if (operation === 'openaiImagesEdits') {
          const prepared = await prepareOpenAIImagesEditsBody(payload as ProviderOperationPayloads['openaiImagesEdits'], deployment);
          body = prepared.body;
          encoding = prepared.encoding;
        } else {
          body = { ...payload, model: deployment };
        }
        if (operation === 'openaiImagesGenerations' || operation === 'openaiImagesEdits') url.searchParams.append('api-version', 'preview');
      }
      const base = withHttpContentType([['api-key', secret(config.apiKey)]], body, encoding);
      const headers = mergeHttpHeaders(base, facts['request.http.headers']);
      const back = await next(move({
        ...rest,
        'request.azure.deployment': deployment,
        'request.http.url': url.href,
        'request.http.method': 'POST',
        'request.http.headers': headers,
        'request.http.body': body,
        'request.http.encoding': encoding,
      }));
      return move({ ...back, 'response.provider.modelKey': deployment, 'response.provider.called': back['response.http.exchange'].type === 'response', 'response.provider.previousCalls': [] });
    },
  });
  return prepare;
};
