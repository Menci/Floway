import type { KimiCodeUpstreamConfig } from './config.ts';
import { selectKimiCodeModel } from './model-selection.ts';
import { scheduleKimiCodeProbes } from './probe.ts';
import { kimiCodeChatSpeedParser, kimiCodeMessagesSpeedParser, kimiCodeMessagesWireBody, kimiCodeResponsesSpeedParser } from './speed.ts';
import { defineStage, pipeline, secret } from '@floway-dev/pipeline';
import type { HeaderEntry, Pipeline, StageEnv } from '@floway-dev/pipeline';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { FAST_SERVICE_TIER, isFastServiceTier } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { parseOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import {
  buildWireHttpUrl,
  httpTerminal,
  parseUpstreamSseOutcome,
  syntheticJsonOutcome,
  type HttpOutcome,
  type ProviderModelFacts,
  type ProviderPipelineAnthropicMessagesCountTokensInput,
  type ProviderPipelineAnthropicMessagesInput,
  type ProviderPipelineOpenAIChatCompletionsInput,
  type ProviderPipelineOpenAIResponsesInput,
  type ProviderPipelineResponsesOutcome,
  type ProviderPipelineServices,
  type ProviderPipelineStreamOutcome,
  type ProviderPipelines,
  type UpstreamHttpRequest,
  type UpstreamRecord,
} from '@floway-dev/provider';

// Coding subscription keys use the regional coding service, independently of
// Moonshot Open Platform keys and billing.
// https://www.kimi.com/code/docs/en/kimi-code/models.html
const BASE_URLS = {
  china: 'https://api.kimi.com/coding/v1',
  overseas: 'https://api.kimi.ai/coding/v1',
} as const;

type PipelineEnv = StageEnv<ProviderPipelineServices>;

type HttpFacts = {
  readonly 'request.http': UpstreamHttpRequest;
  readonly 'provider.modelKey': string;
};

type SelectedModel = Pick<ProviderModelFacts, 'id' | 'upstreamModelId' | 'providerData'>;

type ChatOutcome = ProviderPipelineStreamOutcome<OpenAIChatCompletionsStreamEvent>;
type ResponsesOutcome = ProviderPipelineResponsesOutcome;
type MessagesOutcome = ProviderPipelineStreamOutcome<AnthropicMessagesStreamEventEx>;

const overrideHeaders = (
  base: readonly HeaderEntry[],
  overrides: readonly HeaderEntry[],
): readonly HeaderEntry[] => {
  const names = new Set(overrides.map(([name]) => name.toLowerCase()));
  return [...base.filter(([name]) => !names.has(name.toLowerCase())), ...overrides];
};

const fastServiceTierRequired = (
  env: PipelineEnv,
  model: SelectedModel,
): HttpOutcome => syntheticJsonOutcome(env, {
  status: 400,
  body: {
    error: {
      type: 'invalid_request_error',
      message: `'${model.id}' is only available with fast mode selected; set \`service_tier: "${FAST_SERVICE_TIER}"\`.`,
    },
  },
  modelKey: model.upstreamModelId,
});

const messagesSelectionError = (
  env: PipelineEnv,
  model: SelectedModel,
  error: 'unsupported-fast' | 'fast-required',
): HttpOutcome => syntheticJsonOutcome(env, {
  status: 400,
  body: {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message: error === 'unsupported-fast'
        ? `'${model.id}' does not support fast mode; omit \`speed\` or set \`speed: "standard"\`.`
        : `'${model.id}' is only available with fast mode selected; set \`speed: "fast"\`.`,
    },
  },
  modelKey: model.upstreamModelId,
});

const kimiCodeHeaders = (
  inboundHeaders: readonly HeaderEntry[],
  config: KimiCodeUpstreamConfig,
): readonly HeaderEntry[] => overrideHeaders(inboundHeaders, [['authorization', secret(`Bearer ${config.apiKey}`)]]);

const messagesHeaders = (
  inboundHeaders: readonly HeaderEntry[],
  anthropicBeta: readonly string[],
  config: KimiCodeUpstreamConfig,
): readonly HeaderEntry[] => {
  const ordinary = inboundHeaders.filter(([name]) => name.toLowerCase() !== 'anthropic-beta');
  const betas = anthropicBeta.length === 0 ? [] : [['anthropic-beta', anthropicBeta.join(',')] as const];
  return kimiCodeHeaders([...ordinary, ...betas], config);
};

const withStream = (payload: Readonly<Record<string, unknown>>, modelId: string) => ({
  ...payload,
  model: modelId,
  stream: true,
});

const scheduleProbes = (
  record: UpstreamRecord,
  config: KimiCodeUpstreamConfig,
  http: Pick<HttpOutcome, 'status'>,
  env: PipelineEnv,
): void => {
  // Quota exhaustion and plan restrictions warrant a current read.
  // https://www.kimi.com/code/docs/en/kimi-code/error-reference.html
  scheduleKimiCodeProbes(
    record,
    config,
    env.fetcherFor(record.id),
    env.waitUntil,
    http.status === 429 || http.status === 403,
  );
};

const parseChat = (
  http: HttpOutcome,
  fast: boolean,
  tier: 'priority' | 'default',
  env: PipelineEnv,
): Promise<ChatOutcome> => parseUpstreamSseOutcome(
  http,
  fast ? kimiCodeChatSpeedParser(tier) : parseOpenAIChatCompletionsStream,
  env,
);

const parseResponses = (
  http: HttpOutcome,
  fast: boolean,
  tier: 'priority' | 'default',
  env: PipelineEnv,
): Promise<ProviderPipelineStreamOutcome<OpenAIResponsesStreamEventEx>> => parseUpstreamSseOutcome(
  http,
  fast ? kimiCodeResponsesSpeedParser(tier) : parseOpenAIResponsesStream,
  env,
);

const parseMessages = (
  http: HttpOutcome,
  speed: unknown,
  env: PipelineEnv,
): Promise<MessagesOutcome> => parseUpstreamSseOutcome(
  http,
  speed === 'fast' || speed === 'standard'
    ? kimiCodeMessagesSpeedParser(speed)
    : parseAnthropicMessagesStream,
  env,
);

const selectedMessagesModel = (
  model: SelectedModel,
  speed: unknown,
): { readonly modelId: string; readonly lane: 'fast' | 'standard' } | { readonly error: 'unsupported-fast' | 'fast-required' } => {
  const selection = selectKimiCodeModel(model, speed === 'fast');
  if (speed === 'fast' && selection?.lane !== 'fast') return { error: 'unsupported-fast' };
  return selection ?? { error: 'fast-required' };
};

const createChatPipeline = (
  record: UpstreamRecord,
  config: KimiCodeUpstreamConfig,
): Pipeline<ProviderPipelineOpenAIChatCompletionsInput, ChatOutcome, ProviderPipelineServices> => {
  const stage = defineStage<
    ProviderPipelineOpenAIChatCompletionsInput,
    HttpFacts,
    HttpOutcome,
    ChatOutcome,
    never,
    ProviderPipelineServices
  >({
    name: 'kimi-code.openai-chat-completions',
    provides: ['request.http', 'provider.modelKey'],
    execute: async (facts, next, env) => {
      const model = facts['provider.model'];
      const fast = isFastServiceTier(facts['request.payload'].service_tier);
      const selection = selectKimiCodeModel(model, fast);
      if (selection === undefined) {
        return { ok: false, modelKey: model.upstreamModelId, http: fastServiceTierRequired(env, model) };
      }
      const tier = selection.lane === 'fast' ? FAST_SERVICE_TIER : 'default';
      const payload = fast ? { ...facts['request.payload'], service_tier: tier } : facts['request.payload'];
      const http = await next({
        'request.http': {
          method: 'POST',
          url: buildWireHttpUrl(BASE_URLS[config.region], '/chat/completions'),
          headers: kimiCodeHeaders(facts['request.inboundHeaders'], config),
          body: { kind: 'json', value: withStream(payload, selection.modelId) },
        },
        'provider.modelKey': selection.modelId,
      });
      scheduleProbes(record, config, http, env);
      return await parseChat(http, fast, tier, env);
    },
  });
  return pipeline<ProviderPipelineOpenAIChatCompletionsInput>('kimi-code.openai-chat-completions')
    .use(stage)
    .end(httpTerminal(record.id));
};

const createResponsesPipeline = (
  record: UpstreamRecord,
  config: KimiCodeUpstreamConfig,
): Pipeline<ProviderPipelineOpenAIResponsesInput, ResponsesOutcome, ProviderPipelineServices> => {
  const stage = defineStage<
    ProviderPipelineOpenAIResponsesInput,
    HttpFacts,
    HttpOutcome,
    ResponsesOutcome,
    never,
    ProviderPipelineServices
  >({
    name: 'kimi-code.openai-responses',
    provides: ['request.http', 'provider.modelKey'],
    execute: async (facts, next, env) => {
      if (facts['request.action'] === 'compact') throw new Error('Kimi Code does not expose a native Responses compaction endpoint');
      const model = facts['provider.model'];
      const fast = isFastServiceTier(facts['request.payload'].service_tier);
      const selection = selectKimiCodeModel(model, fast);
      if (selection === undefined) {
        return { action: 'generate', ok: false, modelKey: model.upstreamModelId, http: fastServiceTierRequired(env, model) };
      }
      const tier = selection.lane === 'fast' ? FAST_SERVICE_TIER : 'default';
      const payload = fast ? { ...facts['request.payload'], service_tier: tier } : facts['request.payload'];
      const http = await next({
        'request.http': {
          method: 'POST',
          url: buildWireHttpUrl(BASE_URLS[config.region], '/responses'),
          headers: kimiCodeHeaders(facts['request.inboundHeaders'], config),
          body: { kind: 'json', value: withStream(payload, selection.modelId) },
        },
        'provider.modelKey': selection.modelId,
      });
      scheduleProbes(record, config, http, env);
      return { action: 'generate', ...await parseResponses(http, fast, tier, env) };
    },
  });
  return pipeline<ProviderPipelineOpenAIResponsesInput>('kimi-code.openai-responses')
    .use(stage)
    .end(httpTerminal(record.id));
};

const createMessagesPipeline = (
  record: UpstreamRecord,
  config: KimiCodeUpstreamConfig,
): Pipeline<ProviderPipelineAnthropicMessagesInput, MessagesOutcome, ProviderPipelineServices> => {
  const stage = defineStage<
    ProviderPipelineAnthropicMessagesInput,
    HttpFacts,
    HttpOutcome,
    MessagesOutcome,
    never,
    ProviderPipelineServices
  >({
    name: 'kimi-code.anthropic-messages',
    provides: ['request.http', 'provider.modelKey'],
    execute: async (facts, next, env) => {
      const model = facts['provider.model'];
      const selection = selectedMessagesModel(model, facts['request.payload'].speed);
      if ('error' in selection) {
        return { ok: false, modelKey: model.upstreamModelId, http: messagesSelectionError(env, model, selection.error) };
      }
      const http = await next({
        'request.http': {
          method: 'POST',
          url: buildWireHttpUrl(BASE_URLS[config.region], '/messages'),
          headers: messagesHeaders(facts['request.inboundHeaders'], facts['request.anthropicBeta'], config),
          body: { kind: 'json', value: withStream(kimiCodeMessagesWireBody(facts['request.payload']), selection.modelId) },
        },
        'provider.modelKey': selection.modelId,
      });
      scheduleProbes(record, config, http, env);
      return await parseMessages(http, facts['request.payload'].speed, env);
    },
  });
  return pipeline<ProviderPipelineAnthropicMessagesInput>('kimi-code.anthropic-messages')
    .use(stage)
    .end(httpTerminal(record.id));
};

const createCountTokensPipeline = (
  record: UpstreamRecord,
  config: KimiCodeUpstreamConfig,
): Pipeline<ProviderPipelineAnthropicMessagesCountTokensInput, HttpOutcome, ProviderPipelineServices> => {
  const stage = defineStage<
    ProviderPipelineAnthropicMessagesCountTokensInput,
    HttpFacts,
    HttpOutcome,
    HttpOutcome,
    never,
    ProviderPipelineServices
  >({
    name: 'kimi-code.anthropic-messages-count-tokens',
    provides: ['request.http', 'provider.modelKey'],
    execute: async (facts, next, env) => {
      const model = facts['provider.model'];
      const selection = selectedMessagesModel(model, facts['request.payload'].speed);
      if ('error' in selection) return messagesSelectionError(env, model, selection.error);
      return await next({
        'request.http': {
          method: 'POST',
          url: buildWireHttpUrl(BASE_URLS[config.region], '/messages/count_tokens'),
          headers: messagesHeaders(facts['request.inboundHeaders'], facts['request.anthropicBeta'], config),
          body: { kind: 'json', value: { ...kimiCodeMessagesWireBody(facts['request.payload']), model: selection.modelId } },
        },
        'provider.modelKey': selection.modelId,
      });
    },
  });
  return pipeline<ProviderPipelineAnthropicMessagesCountTokensInput>('kimi-code.anthropic-messages-count-tokens')
    .use(stage)
    .end(httpTerminal(record.id));
};

export const createKimiCodePipelines = (
  record: UpstreamRecord,
  config: KimiCodeUpstreamConfig,
): ProviderPipelines => ({
  openaiChatCompletions: createChatPipeline(record, config),
  openaiResponses: createResponsesPipeline(record, config),
  anthropicMessages: createMessagesPipeline(record, config),
  anthropicMessagesCountTokens: createCountTokensPipeline(record, config),
});
