import type { OllamaUpstreamConfig } from '../config.ts';
import type { HttpRequestFacts } from '@floway-dev/http/pipeline';
import { multipartBody } from '@floway-dev/http/request-content';
import { defineStage, move, secret } from '@floway-dev/pipeline';
import { toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';
import { joinBaseAndPath, mergeHttpHeaders, withHttpContentType, type ProviderOperationPayloads, type ProviderRequest, type ProviderResponse, type ProviderServices } from '@floway-dev/provider';

type OllamaOperation = 'openaiChatCompletions' | 'openaiResponses' | 'openaiResponsesCompact' | 'anthropicMessages' | 'anthropicMessagesCountTokens' | 'openaiCompletions' | 'openaiEmbeddings' | 'openaiAudioTranscriptions';

interface OllamaHttpFacts extends HttpRequestFacts {
  'request.provider.modelKey': string;
  'request.ollama.modelKey': string;
}

const PATHS: Record<OllamaOperation, string> = {
  openaiChatCompletions: '/v1/chat/completions',
  openaiResponses: '/v1/responses',
  openaiResponsesCompact: '/v1/responses/compact',
  anthropicMessages: '/v1/messages',
  anthropicMessagesCountTokens: '/v1/messages/count_tokens',
  openaiCompletions: '/v1/completions',
  openaiEmbeddings: '/v1/embeddings',
  // https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/server/routes.go#L1916-L1922
  openaiAudioTranscriptions: '/v1/audio/transcriptions',
};

export const prepareOllamaRequest = <O extends OllamaOperation>(config: OllamaUpstreamConfig, operation: O) => {
  const prepare = defineStage<ProviderRequest<ProviderOperationPayloads[O]> & { 'request.provider.anthropicBeta'?: readonly string[]; 'request.provider.responsesAction': 'generate' | 'compact' }, OllamaHttpFacts, ProviderResponse, ProviderResponse, ProviderServices>({
    name: `prepareOllama${operation.replace(/^openai/, 'OpenAI').replace(/^alpha/, 'Alpha').replace(/^rerank/, 'Rerank')}`,
    through: {
      request: {
        needs: [...(operation === 'openaiResponses' || operation === 'openaiResponsesCompact' ? ['request.provider.responsesAction' as const] : []), 'request.provider.model', 'request.provider.payload', 'request.http.callId', 'request.http.headers', ...(operation === 'anthropicMessages' || operation === 'anthropicMessagesCountTokens' ? ['request.provider.anthropicBeta' as const] : [])],
        consumes: ['request.provider.model', 'request.provider.payload', 'request.http.headers'],
        provides: ['request.http.url', 'request.http.method', 'request.http.headers', 'request.http.body', 'request.http.encoding', 'request.provider.modelKey', 'request.ollama.modelKey'],
      },
      response: { needs: [], consumes: [], provides: [] },
    },
    execute: async (facts, next) => {
      const { 'request.provider.model': model, 'request.provider.payload': payload, ...rest } = facts;
      const modelKey = model.providerData as string;
      const encoding = operation === 'openaiAudioTranscriptions' ? 'multipart' as const : 'json' as const;
      const body = operation === 'openaiAudioTranscriptions'
        ? multipartBody((payload as ProviderOperationPayloads['openaiAudioTranscriptions']).entries.map(entry => entry.name === 'model' ? { ...entry, value: modelKey } : entry))
        : (operation === 'openaiResponses' || operation === 'openaiResponsesCompact') && facts['request.provider.responsesAction'] === 'compact'
            ? { ...toCompactPayloadShape(payload as ProviderOperationPayloads['openaiResponsesCompact']), model: modelKey }
            : { ...payload, ...(operation === 'openaiChatCompletions' || operation === 'openaiResponses' || operation === 'openaiResponsesCompact' || operation === 'anthropicMessages' ? { stream: true } : {}), model: modelKey };
      const base = config.apiKey ? [['Authorization', secret(`Bearer ${config.apiKey}`)] as const] : [];
      let headers = mergeHttpHeaders(withHttpContentType(base, body, encoding), facts['request.http.headers']);
      if ('request.provider.anthropicBeta' in facts) {
        const beta = facts['request.provider.anthropicBeta'] as readonly string[];
        headers = headers.filter(([name]) => name.toLowerCase() !== 'anthropic-beta');
        if (beta.length > 0) headers = [...headers, ['anthropic-beta', beta.join(',')]];
      }
      const back = await next(move({
        ...rest,
        'request.provider.modelKey': modelKey,
        'request.ollama.modelKey': modelKey,
        'request.http.url': joinBaseAndPath(config.baseUrl, ((operation === 'openaiResponses' || operation === 'openaiResponsesCompact') ? PATHS[facts['request.provider.responsesAction'] === 'compact' ? 'openaiResponsesCompact' : 'openaiResponses'] : PATHS[operation])),
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
