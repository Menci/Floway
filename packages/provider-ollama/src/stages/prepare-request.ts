import type { OllamaUpstreamConfig } from '../config.ts';
import type { HttpRequestFacts, HttpResponseFacts } from '@floway-dev/http/pipeline';
import { multipartBody } from '@floway-dev/http/request-content';
import { defineStage, move, secret } from '@floway-dev/pipeline';
import { joinBaseAndPath, mergeHttpHeaders, withHttpContentType, type ProviderOperationPayloads, type ProviderRequest, type ProviderResponse, type ProviderServices } from '@floway-dev/provider';

type OllamaOperation = 'openaiCompletions' | 'openaiEmbeddings' | 'openaiAudioTranscriptions';

interface OllamaHttpFacts extends HttpRequestFacts {
  'request.ollama.modelKey': string;
}

const PATHS: Record<OllamaOperation, string> = {
  openaiCompletions: '/v1/completions',
  openaiEmbeddings: '/v1/embeddings',
  // https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/server/routes.go#L1916-L1922
  openaiAudioTranscriptions: '/v1/audio/transcriptions',
};

export const prepareOllamaRequest = <O extends OllamaOperation>(config: OllamaUpstreamConfig, operation: O) => {
  const prepare = defineStage<ProviderRequest<ProviderOperationPayloads[O]>, OllamaHttpFacts, HttpResponseFacts, ProviderResponse, ProviderServices>({
    name: `prepareOllama${operation.replace(/^openai/, 'OpenAI').replace(/^alpha/, 'Alpha').replace(/^rerank/, 'Rerank')}`,
    through: {
      request: {
        needs: ['request.provider.model', 'request.provider.payload', 'request.http.callId', 'request.http.headers'],
        consumes: ['request.provider.model', 'request.provider.payload', 'request.http.headers'],
        provides: ['request.http.url', 'request.http.method', 'request.http.headers', 'request.http.body', 'request.http.encoding', 'request.ollama.modelKey'],
      },
      response: { needs: ['response.http.exchange'], consumes: [], provides: ['response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls'] },
    },
    execute: async (facts, next) => {
      const { 'request.provider.model': model, 'request.provider.payload': payload, ...rest } = facts;
      const modelKey = model.providerData as string;
      const encoding = operation === 'openaiAudioTranscriptions' ? 'multipart' as const : 'json' as const;
      const body = operation === 'openaiAudioTranscriptions'
        ? multipartBody((payload as ProviderOperationPayloads['openaiAudioTranscriptions']).entries.map(entry => entry.name === 'model' ? { ...entry, value: modelKey } : entry))
        : { ...payload, model: modelKey };
      const base = config.apiKey ? [['Authorization', secret(`Bearer ${config.apiKey}`)] as const] : [];
      const headers = mergeHttpHeaders(withHttpContentType(base, body, encoding), facts['request.http.headers']);
      const back = await next(move({
        ...rest,
        'request.ollama.modelKey': modelKey,
        'request.http.url': joinBaseAndPath(config.baseUrl, PATHS[operation]),
        'request.http.method': 'POST',
        'request.http.headers': headers,
        'request.http.body': body,
        'request.http.encoding': encoding,
      }));
      return move({ ...back, 'response.provider.modelKey': modelKey, 'response.provider.called': back['response.http.exchange'].type === 'response', 'response.provider.previousCalls': [] });
    },
  });
  return prepare;
};
