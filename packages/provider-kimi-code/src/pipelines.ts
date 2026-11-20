import type { KimiCodeUpstreamConfig } from './config.ts';
import { kimiCodeUrl } from './fetch.ts';
import { selectKimiCodeModel } from './model-selection.ts';
import { scheduleKimiCodeProbes } from './probe.ts';
import { kimiCodeChatSpeed, kimiCodeMessagesSpeed, kimiCodeMessagesWireBody, kimiCodeResponsesSpeed } from './speed.ts';
import { http, takeHttpResponse, type HttpHeaders, type HttpRequestFacts } from '@floway-dev/http/pipeline';
import { compose, defineStage, move, secret } from '@floway-dev/pipeline';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { FAST_SERVICE_TIER, isFastServiceTier, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { decodeProviderResponse, observeProviderCall, observeProviderResponsesCall, selectProviderResponsesAction, type ProviderChatResponse, type ProviderChatServices, type ProviderOperationRequest, type ProviderPipelines, type UpstreamRecord } from '@floway-dev/provider';

const PATH = {
  openaiChatCompletions: '/chat/completions',
  openaiResponses: '/responses',
  anthropicMessages: '/messages',
  anthropicMessagesCountTokens: '/messages/count_tokens',
} as const;
type Operation = keyof typeof PATH;
type Request<O extends Operation> = ProviderOperationRequest<O> & { 'request.provider.anthropicBeta'?: readonly string[] };
type Prepared = HttpRequestFacts & { 'request.provider.modelKey': string };
type Reply<O extends Operation> = ProviderChatResponse<O> & Record<string, unknown>;
type Mark = 'priority' | 'default' | 'fast' | 'standard';

const withSpeed = <O extends Operation>(
  operation: O,
  reply: Reply<O>,
  mark: Mark,
  record: ProviderChatServices['recordProtocolFrames'],
): Reply<O> => {
  const output = reply['response.provider.output'];
  if (output === null || !('kind' in output) || output.kind !== 'stream') return reply;
  const frames = operation === 'openaiChatCompletions' ? kimiCodeChatSpeed(output.frames as AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>, mark as 'priority' | 'default')
    : operation === 'openaiResponses' ? kimiCodeResponsesSpeed(output.frames as AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>, mark as 'priority' | 'default')
      : kimiCodeMessagesSpeed(output.frames as AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>, mark as 'fast' | 'standard');
  return move({ ...reply, 'response.provider.output': { kind: 'stream', frames: record(frames as AsyncIterable<ProtocolFrame<unknown>>) } }) as Reply<O>;
};

const prepareKimiCode = <O extends Operation>(record: UpstreamRecord, config: KimiCodeUpstreamConfig, operation: O) => {
  const messages = operation === 'anthropicMessages' || operation === 'anthropicMessagesCountTokens';
  const streaming = operation !== 'anthropicMessagesCountTokens';
  return defineStage<Request<O>, Prepared, Reply<O>, Reply<O>, Reply<O>, ProviderChatServices>({
    name: `prepareKimiCode${operation[0].toUpperCase()}${operation.slice(1)}`,
    through: {
      request: {
        needs: ['request.provider.model', 'request.provider.payload', 'request.http.callId', 'request.http.headers', ...(messages ? ['request.provider.anthropicBeta' as const] : [])],
        consumes: ['request.provider.model', 'request.provider.payload', 'request.http.headers'],
        provides: ['request.provider.modelKey', 'request.http.url', 'request.http.method', 'request.http.headers', 'request.http.body', 'request.http.encoding'],
      },
      response: { needs: ['response.http.exchange', 'response.provider.output'], consumes: [], provides: ['response.provider.output'] },
    },
    return: { provides: ['response.http.exchange', 'response.http.body', 'response.provider.output', 'response.provider.modelKey', 'response.provider.called', 'response.provider.previousCalls'] },
    execute: async (facts, next, use) => {
      const { 'request.provider.model': model, 'request.provider.payload': payload, ...entry } = facts;
      const body = payload as Record<string, unknown>;
      const fast = messages ? body.speed === 'fast' : typeof body.service_tier === 'string' && isFastServiceTier(body.service_tier);
      const selection = selectKimiCodeModel(model, fast);
      const unsupportedSpeed = messages && fast && selection?.lane !== 'fast';
      if (selection === undefined || unsupportedSpeed) {
        const field = messages ? 'speed' : 'service_tier';
        const message = unsupportedSpeed
          ? `'${model.id}' does not support fast mode; omit \`speed\` or set \`speed: "standard"\`.`
          : `'${model.id}' is only available with fast mode selected; set \`${field}: "${messages ? 'fast' : FAST_SERVICE_TIER}"\`.`;
        const exchange = takeHttpResponse(Response.json({
          ...(messages ? { type: 'error' } : {}),
          error: { type: 'invalid_request_error', message },
        }, { status: 400 }));
        return move({
          ...facts,
          'response.http.exchange': exchange,
          'response.http.body': exchange.body,
          'response.provider.output': null,
          'response.provider.modelKey': model.upstreamModelId,
          'response.provider.called': false,
          'response.provider.previousCalls': [],
        }) as Reply<O>;
      }

      const { modelId, lane } = selection;
      const tier = lane === 'fast' ? FAST_SERVICE_TIER : 'default';
      const mark = messages
        ? body.speed === 'fast' || body.speed === 'standard' ? body.speed : null
        : fast ? tier : null;
      const wireBody = messages ? kimiCodeMessagesWireBody(body) : fast ? { ...body, service_tier: tier } : body;
      const supplied = new Set(['authorization', 'content-type', ...(messages ? ['anthropic-beta'] : [])]);
      const beta = facts['request.provider.anthropicBeta'];
      const headers: HttpHeaders = [
        ...facts['request.http.headers'].filter(([name]) => !supplied.has(name.toLowerCase())),
        ['authorization', secret(`Bearer ${config.apiKey}`)],
        ['content-type', 'application/json'],
        ...(messages && beta?.length ? [['anthropic-beta', beta.join(',')] as const] : []),
      ];
      // Requests retain open vendor fields while the catalog-selected raw ID is
      // applied only on the owning wire.
      // https://www.kimi.com/code/docs/en/kimi-code/models.html
      const reply = await next(move({
        ...entry,
        'request.provider.modelKey': modelId,
        'request.http.url': kimiCodeUrl(config, PATH[operation]),
        'request.http.method': 'POST',
        'request.http.headers': headers,
        'request.http.body': { ...wireBody, ...(streaming ? { stream: true } : {}), model: modelId },
        'request.http.encoding': 'json' as const,
      }));
      const exchange = reply['response.http.exchange'];
      if (streaming && exchange.type === 'response') {
        // Quota and plan failures warrant refreshing observations immediately.
        // https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
        const { fetcher, waitUntil } = use.httpCall(facts['request.http.callId']);
        scheduleKimiCodeProbes(record, config, fetcher, waitUntil, exchange.status === 429 || exchange.status === 403);
      }
      return mark === null ? reply : withSpeed(operation, reply, mark, use.recordProtocolFrames);
    },
  });
};

export const createKimiCodePipelines = (record: UpstreamRecord, config: KimiCodeUpstreamConfig): ProviderPipelines => ({
  openaiChatCompletions: compose('kimiCode.openaiChatCompletions', [
    prepareKimiCode(record, config, 'openaiChatCompletions'), decodeProviderResponse('openaiChatCompletions'), observeProviderCall, http,
  ]),
  openaiResponses: compose('kimiCode.openaiResponses', [
    selectProviderResponsesAction('generate'), prepareKimiCode(record, config, 'openaiResponses'), decodeProviderResponse('openaiResponses'), observeProviderResponsesCall, http,
  ]),
  anthropicMessages: compose('kimiCode.anthropicMessages', [
    prepareKimiCode(record, config, 'anthropicMessages'), decodeProviderResponse('anthropicMessages'), observeProviderCall, http,
  ]),
  anthropicMessagesCountTokens: compose('kimiCode.anthropicMessagesCountTokens', [
    prepareKimiCode(record, config, 'anthropicMessagesCountTokens'), decodeProviderResponse('anthropicMessagesCountTokens'), observeProviderCall, http,
  ]),
});
