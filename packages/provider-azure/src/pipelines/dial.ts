import { azureAnthropicBaseUrl, azureOpenAIV1BaseUrl } from '../endpoint.ts';
import type { AzureUpstream } from '../upstream.ts';
import { stripAzureAnthropicMessagesHeaders, stripAzureHeaders } from './strip-headers.ts';
import { getHeader, setHeader, type HttpResponseFact } from '@floway-dev/http';
import { factSpace } from '@floway-dev/pipeline';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import { httpDialError, httpTerminal, joinBaseAndPath, type FormatProtocolError, type GatewayFacts, type ProviderOperation, type ProviderOperationFacts, type ProviderServices } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<ProviderOperation, AzureUpstream>, ProviderServices>();
type Stage = Parameters<typeof compose>[1]['stages'][number];
type RequestKey = `request.${ProviderOperation}`;
type ResponseKey = `response.${ProviderOperation}`;

type Surface = 'openai' | 'anthropicMessages';

interface SerializedBody {
  contentType: string;
  body: Uint8Array;
}

interface DialRequest extends SerializedBody {
  url: string;
}

type Payload<Op extends ProviderOperation> = GatewayFacts[`request.${Op}`];
type Prepare<Op extends ProviderOperation> = (payload: Payload<Op>, modelId: string, endpoint: string) => DialRequest | Promise<DialRequest>;

export const openAIError: FormatProtocolError = (status, message) => ({
  error: { type: status !== null && status >= 400 && status < 500 ? 'invalid_request_error' : 'server_error', message },
});

export const anthropicMessagesError: FormatProtocolError = (status, message) => ({
  type: 'error',
  error: { type: status !== null && status >= 400 && status < 500 ? 'invalid_request_error' : 'api_error', message },
});

const azureDial = <Op extends ProviderOperation>(
  operation: Op,
  surface: Surface,
  prepare: Prepare<NoInfer<Op>>,
  format: FormatProtocolError,
) => {
  const payload: RequestKey = `request.${operation}`;
  const outcome: ResponseKey = `response.${operation}`;
  const requestNeeds: readonly ['request.http', 'provider.upstream', 'provider.model', RequestKey] = ['request.http', 'provider.upstream', 'provider.model', payload];
  const responseProvides: readonly [`${ResponseKey}?`, 'response.usageModelKey?'] = [`${outcome}?`, 'response.usageModelKey?'];
  return defineStage({
    name: `azure.${operation}.dial`,
    through: {
      request: { needs: requestNeeds, provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: responseProvides, consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const request = facts['request.http'];
      const { apiKey, endpoint } = facts['provider.upstream'].config;
      const { upstreamModelId: modelId } = facts['provider.model'];
      const { url, contentType, body } = await prepare(facts[payload] as Payload<Op>, modelId, endpoint);
      // https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/model-router-apis
      let headers = setHeader(request.headers, surface === 'openai' ? 'api-key' : 'x-api-key', apiKey);
      if (surface === 'anthropicMessages') headers = setHeader(headers, 'anthropic-version', '2023-06-01');
      headers = setHeader(headers, 'content-type', contentType);
      const { 'response.http.error': error, ...response } = await scope.next({
        ...facts,
        'request.http': { ...request, method: 'POST', url, headers, body },
      });
      const answer = { ...response, 'response.usageModelKey': modelId };
      return error === undefined ? answer : { ...answer, [outcome]: httpDialError(error, format) };
    },
  });
};

interface AzureOperation<Op extends ProviderOperation> {
  parse: Stage;
  prepare: Prepare<Op>;
  surface?: Surface;
  stages?: readonly Stage[];
}

export const azureOperation = <Op extends ProviderOperation>(
  operation: Op,
  { parse, prepare, surface = 'openai', stages = [] }: AzureOperation<NoInfer<Op>>,
) => {
  const filter = surface === 'openai' ? stripAzureHeaders : stripAzureAnthropicMessagesHeaders;
  const format = surface === 'openai' ? openAIError : anthropicMessagesError;
  return compose(`azure.${operation}`, {
    entry: ['request.http', 'provider.upstream', 'provider.model', `request.${operation}`] as const,
    exit: ['response.http', `response.${operation}`, 'response.usageModelKey?'] as const,
    stages: [filter, ...stages, parse, azureDial(operation, surface, prepare, format)],
    ending: httpTerminal,
  });
};

export const jsonBody = (payload: object): SerializedBody => ({
  contentType: 'application/json',
  body: new TextEncoder().encode(JSON.stringify(payload)),
});

export const formBody = async (form: FormData): Promise<SerializedBody> => {
  const response = new Response(form);
  const contentType = response.headers.get('content-type');
  if (contentType === null) throw new Error('Multipart serialization must supply a Content-Type');
  return { contentType, body: await response.bytes() };
};

export const selectEventStream = (head: Omit<HttpResponseFact, 'body'>): 'stream' | 'result' => {
  const contentType = getHeader(head.headers, 'content-type');
  return typeof contentType === 'string' && isEventStreamMediaType(contentType) ? 'stream' : 'result';
};

export const azureOpenAIUrl = (endpoint: string, path: string): string =>
  joinBaseAndPath(azureOpenAIV1BaseUrl(endpoint), path);

export const azureAnthropicMessagesUrl = (endpoint: string, path: string): string =>
  joinBaseAndPath(azureAnthropicBaseUrl(endpoint), path);
