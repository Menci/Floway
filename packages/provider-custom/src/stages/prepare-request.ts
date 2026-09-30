import type { CustomPathOverrideKey, CustomUpstreamConfig } from '../config.ts';
import { type HttpHeaders, type HttpRequestFacts, type HttpResponseFacts } from '@floway-dev/http/pipeline';
import { multipartBody, type HttpBody, type HttpBodyEncoding } from '@floway-dev/http/request-content';
import { defineStage, isSecret, move, secret, type Secret } from '@floway-dev/pipeline';
import type { RerankTarget } from '@floway-dev/protocols/common';
import { DEFAULT_RERANK_PATHS, serializeRerankRequest } from '@floway-dev/protocols/rerank';
import { joinBaseAndPath, mergeHttpHeaders, prepareOpenAIImagesEditsBody, replaceHttpHeader, withHttpContentType, type ProviderOperation, type ProviderOperationPayloads, type ProviderRequest, type ProviderResponse, type ProviderServices } from '@floway-dev/provider';

interface CustomHttpFacts extends HttpRequestFacts {
  'request.custom.modelKey': string;
  'request.custom.path': string;
}

type CustomResponse = ProviderResponse & { 'response.provider.rerankTarget'?: RerankTarget };

const PATHS: Partial<Record<ProviderOperation, CustomPathOverrideKey>> = {
  alphaSearch: '/alpha/search',
  openaiCompletions: '/completions',
  openaiEmbeddings: '/embeddings',
  openaiImagesGenerations: '/images/generations',
  openaiImagesEdits: '/images/edits',
  openaiAudioTranscriptions: '/audio/transcriptions',
};

const resolvedHeaders = (config: CustomUpstreamConfig, incoming: HttpHeaders): HttpHeaders => {
  const names = new Set(config.ingressHeadersRules.map(rule => rule.key.toLowerCase()));
  const output: (readonly [string, string | Secret<string>])[] = incoming.filter(([name]) => !names.has(name.toLowerCase()));
  for (const rule of config.ingressHeadersRules) {
    if (rule.value !== null) output.push([rule.key, rule.value]);
    else {
      const values = incoming.filter(([name]) => name.toLowerCase() === rule.key.toLowerCase()).map(([, value]) => value);
      if (values.length === 1) output.push([rule.key, values[0]!]);
      else if (values.length > 1) {
        const value = values.map(value => isSecret(value) ? value.reveal() : value).join(', ');
        output.push([rule.key, values.some(isSecret) ? secret(value) : value]);
      }
    }
  }
  return output;
};

export const prepareCustomRequest = <O extends ProviderOperation>(config: CustomUpstreamConfig, operation: O) => {
  const prepare = defineStage<ProviderRequest<ProviderOperationPayloads[O]>, CustomHttpFacts, HttpResponseFacts, CustomResponse, ProviderServices>({
    name: `prepareCustom${operation.replace(/^openai/, 'OpenAI').replace(/^alpha/, 'Alpha').replace(/^rerank/, 'Rerank')}`,
    through: {
      request: {
        needs: ['request.provider.model', 'request.provider.payload', 'request.http.callId', 'request.http.headers'],
        consumes: ['request.provider.model', 'request.provider.payload', 'request.http.headers'],
        provides: ['request.http.url', 'request.http.method', 'request.http.headers', 'request.http.body', 'request.http.encoding', 'request.custom.modelKey', 'request.custom.path'],
      },
      response: {
        needs: ['response.http.exchange'],
        consumes: [],
        provides: ['response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls', ...(operation === 'rerank' ? ['response.provider.rerankTarget' as const] : [])],
      },
    },
    execute: async (facts, next) => {
      const { 'request.provider.model': model, 'request.provider.payload': payload, ...rest } = facts;
      const modelKey = model.providerData as string;
      let body: HttpBody;
      let encoding: HttpBodyEncoding = 'json';
      let target: RerankTarget | undefined;
      let path: string;
      switch (operation) {
      case 'rerank':
        target = model.rerankTarget;
        if (target === undefined) throw new Error(`Rerank model ${model.id} has no outbound target`);
        path = target.path ?? DEFAULT_RERANK_PATHS[target.protocol];
        body = serializeRerankRequest(target.protocol, modelKey, payload as ProviderOperationPayloads['rerank']);
        break;
      case 'openaiImagesEdits': {
        const prepared = await prepareOpenAIImagesEditsBody(payload as ProviderOperationPayloads['openaiImagesEdits'], modelKey);
        body = prepared.body;
        encoding = prepared.encoding;
        path = config.pathOverrides?.['/images/edits'] ?? '/v1/images/edits';
        break;
      }
      case 'openaiAudioTranscriptions': {
        const request = payload as ProviderOperationPayloads['openaiAudioTranscriptions'];
        body = multipartBody(request.entries.map(entry => entry.name === 'model' ? { ...entry, value: modelKey } : entry));
        encoding = 'multipart';
        path = config.pathOverrides?.['/audio/transcriptions'] ?? '/v1/audio/transcriptions';
        break;
      }
      default: {
        const key = PATHS[operation]!;
        path = config.pathOverrides?.[key] ?? `/v1${key}`;
        body = { ...payload, model: modelKey };
      }
      }
      let base: HttpHeaders = [];
      if (config.authStyle === 'anthropic') {
      // https://docs.anthropic.com/en/api/versioning
        base = [['x-api-key', secret(config.apiKey)], ['anthropic-version', '2023-06-01']];
      } else if (config.authStyle === 'bearer') {
        base = replaceHttpHeader(base, 'Authorization', secret(`Bearer ${config.apiKey}`));
      }
      base = withHttpContentType(base, body, encoding);
      const headers = mergeHttpHeaders(base, resolvedHeaders(config, facts['request.http.headers']));
      const back = await next(move({
        ...rest,
        'request.custom.modelKey': modelKey,
        'request.custom.path': path,
        'request.http.url': joinBaseAndPath(config.baseUrl, path),
        'request.http.method': 'POST',
        'request.http.headers': headers,
        'request.http.body': body,
        'request.http.encoding': encoding,
      }));
      return move({ ...back, 'response.provider.modelKey': modelKey, 'response.provider.called': back['response.http.exchange'].type === 'response', 'response.provider.previousCalls': [], ...(target === undefined ? {} : { 'response.provider.rerankTarget': target }) });
    },
  });
  return prepare;
};
