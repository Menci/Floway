import type { CustomAuthStyle } from '../config.ts';
import type { CustomUpstream } from '../upstream.ts';
import { applyCustomAnthropicMessagesIngressHeaderRules, applyCustomIngressHeaderRules } from './apply-ingress-header-rules.ts';
import { getHeader, hasHeader, setHeader, type HttpHeaders, type HttpResponseFact } from '@floway-dev/http';
import { factSpace } from '@floway-dev/pipeline';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import { geminiGenerateContentStatusForHttpStatus } from '@floway-dev/protocols/gemini-generate-content';
import { httpDialError, httpTerminal, joinBaseAndPath, type FormatProtocolError, type GatewayFacts, type ProviderModelFact, type ProviderOperation, type ProviderOperationFacts, type ProviderServices } from '@floway-dev/provider';

const { compose, defineStage } = factSpace<ProviderOperationFacts<ProviderOperation, CustomUpstream>, ProviderServices>();
type Stage = Parameters<typeof compose>[1]['stages'][number];
type RequestKey = `request.${ProviderOperation}`;
type ResponseKey = `response.${ProviderOperation}`;

interface SerializedBody {
  contentType: string;
  body: Uint8Array;
}

interface DialRequest extends SerializedBody {
  path: string;
}

type Payload<Op extends ProviderOperation> = GatewayFacts[`request.${Op}`];
type Prepare<Op extends ProviderOperation> = (payload: Payload<Op>, model: ProviderModelFact, config: CustomUpstream['config']) => DialRequest | Promise<DialRequest>;

export const openAIError: FormatProtocolError = (status, message) => ({
  error: { type: status !== null && status >= 400 && status < 500 ? 'invalid_request_error' : 'server_error', message },
});

export const anthropicMessagesError: FormatProtocolError = (status, message) => ({
  type: 'error',
  error: { type: status !== null && status >= 400 && status < 500 ? 'invalid_request_error' : 'api_error', message },
});

// https://ai.google.dev/api/rest/v1beta/Status
const geminiErrorStatuses = new Set([400, 401, 403, 404, 429, 500, 502, 503]);

export const geminiGenerateContentError: FormatProtocolError = (status, message) => {
  const code = status !== null && geminiErrorStatuses.has(status) ? status : 500;
  return { error: { code, message, status: geminiGenerateContentStatusForHttpStatus(code)! } };
};

const errorFormats = {
  bearer: openAIError,
  'x-api-key': anthropicMessagesError,
  'x-goog-api-key': geminiGenerateContentError,
} satisfies Record<CustomAuthStyle, FormatProtocolError>;

const authenticatedHeaders = (
  headers: HttpHeaders,
  auth: CustomAuthStyle,
  apiKey: CustomUpstream['config']['apiKey'],
): HttpHeaders => {
  if (apiKey === undefined) return headers;
  // https://platform.openai.com/docs/api-reference/authentication
  if (auth === 'bearer') return setHeader(headers, 'authorization', apiKey.map(value => `Bearer ${value}`));
  const authenticated = setHeader(headers, auth, apiKey);
  // https://platform.claude.com/docs/en/api/versioning
  // https://ai.google.dev/gemini-api/docs/api-key
  return auth === 'x-api-key' && !hasHeader(authenticated, 'anthropic-version')
    ? setHeader(authenticated, 'anthropic-version', '2023-06-01')
    : authenticated;
};

const customDial = <Op extends ProviderOperation>(operation: Op, auth: CustomAuthStyle, prepare: Prepare<NoInfer<Op>>) => {
  const payload: RequestKey = `request.${operation}`;
  const outcome: ResponseKey = `response.${operation}`;
  const requestNeeds: readonly ['request.http', 'provider.upstream', 'provider.model', RequestKey] = ['request.http', 'provider.upstream', 'provider.model', payload];
  const responseProvides: readonly [`${ResponseKey}?`] = [`${outcome}?`];
  return defineStage({
    name: `custom.${operation}.dial`,
    through: {
      request: { needs: requestNeeds, provides: ['request.http'], consumes: [] },
      response: { needs: ['response.http', 'response.http.error?'], provides: responseProvides, consumes: ['response.http.error'] },
    },
    async execute(facts, scope) {
      const request = facts['request.http'];
      const { config } = facts['provider.upstream'];
      const { path, contentType, body } = await prepare(facts[payload] as Payload<Op>, facts['provider.model'], config);
      const url = joinBaseAndPath(config.baseUrl, path);
      const headers = setHeader(authenticatedHeaders(request.headers, auth, config.apiKey), 'content-type', contentType);
      const { 'response.http.error': error, ...answer } = await scope.next({
        ...facts,
        'request.http': { ...request, method: 'POST', url, headers, body },
      });
      return error === undefined ? answer : { ...answer, [outcome]: httpDialError(error, errorFormats[auth]) };
    },
  });
};

interface CustomOperation<Op extends ProviderOperation> {
  parse: Stage;
  prepare: Prepare<Op>;
  auth?: CustomAuthStyle;
  stages?: readonly Stage[];
}

export const customOperation = <Op extends ProviderOperation>(
  operation: Op,
  { parse, prepare, auth = 'bearer', stages = [] }: CustomOperation<NoInfer<Op>>,
) => {
  const filter = auth === 'x-api-key' ? applyCustomAnthropicMessagesIngressHeaderRules : applyCustomIngressHeaderRules;
  return compose(`custom.${operation}`, {
    entry: ['request.http', 'provider.upstream', 'provider.model', `request.${operation}`] as const,
    exit: ['response.http', `response.${operation}`] as const,
    stages: [filter, ...stages, parse, customDial(operation, auth, prepare)],
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
