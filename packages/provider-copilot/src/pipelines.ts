import { copilotBaseHeaderEntries, ensureCopilotToken, isCopilotTokenFetchError } from './auth.ts';
import { COMPACTION_TRIGGER, compactionResponse } from './compaction.ts';
import { captureQuotaFireAndForget } from './fetch.ts';
import { CONTEXT_1M_BETA } from './model-selection.ts';
import { anthropicMessagesReasoningEffort, chatReasoningEffort, copilotModelHasFastVariant, copilotOpenAIEmbeddingsBody, openaiResponsesReasoningEffort, rawModelFor } from './routing.ts';
import { applyCopilotTopLevelCacheControl } from './stages/anthropic-messages/apply-top-level-cache-control.ts';
import { compressCopilotAnthropicMessagesImages } from './stages/anthropic-messages/compress-images.ts';
import { parseUserIdMetadata, type ClaudeCodeMetadata } from './stages/anthropic-messages/detect-claude-code-metadata.ts';
import { normalizeCopilotAnthropicBeta } from './stages/anthropic-messages/normalize-anthropic-beta.ts';
import { omitPromotedThinkingTextFromProtocolFrames, promoteCopilotThinkingDisplay } from './stages/anthropic-messages/promote-thinking-display.ts';
import { isCopilotContextWindowError } from './stages/anthropic-messages/rewrite-context-window-error.ts';
import { copilotClaudeAgentHeaderOverrides } from './stages/anthropic-messages/set-claude-agent-headers.ts';
import { applyCopilotCompactHeaders, classifyCopilotCompact } from './stages/anthropic-messages/set-compact-headers.ts';
import { copilotSessionUuid } from './stages/anthropic-messages/set-interaction-id-header.ts';
import { copilotAnthropicContentHasImage } from './stages/anthropic-messages/set-vision-header.ts';
import { stripCopilotCacheControlExtensions } from './stages/anthropic-messages/strip-cache-control-extensions.ts';
import { stripCopilotEagerInputStreaming } from './stages/anthropic-messages/strip-eager-input-streaming.ts';
import { abortCopilotOpenAIChatCompletionsToolArgumentWhitespace } from './stages/openai-chat-completions/abort-on-tool-argument-whitespace.ts';
import { attachCopilotCacheControlMarkers } from './stages/openai-chat-completions/attach-cache-control-markers.ts';
import { compressCopilotOpenAIChatCompletionsImages } from './stages/openai-chat-completions/compress-images.ts';
import { copilotOpenAIChatCompletionsInitiator } from './stages/openai-chat-completions/set-initiator-header.ts';
import { copilotOpenAIChatCompletionsHasImage } from './stages/openai-chat-completions/set-vision-header.ts';
import { abortCopilotOpenAIResponsesToolArgumentWhitespace } from './stages/openai-responses/abort-on-tool-argument-whitespace.ts';
import { compressCopilotOpenAIResponsesImages } from './stages/openai-responses/compress-images.ts';
import { fillCopilotEmptyNamespaceDescriptions } from './stages/openai-responses/fill-empty-namespace-descriptions.ts';
import { normalizeCopilotOpenAIResponsesCompactionResult, normalizeCopilotOpenAIResponsesFrames, restoreCopilotOpenAIResponsesInputItemIds } from './stages/openai-responses/item-id-membrane.ts';
import { copilotOpenAIResponsesInitiator } from './stages/openai-responses/set-initiator-header.ts';
import { copilotOpenAIResponsesHasImage } from './stages/openai-responses/set-vision-header.ts';
import { stripCopilotImageGeneration } from './stages/openai-responses/strip-image-generation.ts';
import { stripCopilotServiceTier } from './stages/openai-responses/strip-service-tier.ts';
import type { CopilotRawModel } from './types.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { AnyStage, Ending, HeaderEntry, Pipeline, Stage, StageEnv } from '@floway-dev/pipeline';
import { buildPromptTooLongBody, parseAnthropicMessagesStream, type AnthropicMessagesPayload, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, isFastServiceTier, type DecisionTarget, type ProtocolFrame } from '@floway-dev/protocols/common';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest } from '@floway-dev/protocols/decision';
import { parseOpenAIChatCompletionsStream, type OpenAIChatCompletionsPayloadEx, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesResultEx } from '@floway-dev/protocols/openai-responses';
import {
  buildImagesEditsHttpBody,
  buildWireHttpUrl,
  bytesToManagedStream,
  headersFromEntries,
  httpTerminal,
  parseUpstreamSseOutcome,
  readManagedBytes,
  syntheticJsonOutcome,
  wrapSensitiveHeaderEntries,
} from '@floway-dev/provider';
import type {
  HttpOutcome,
  HttpRequestBody,
  ProviderModelFacts,
  ProviderPipelineAnthropicMessagesCountTokensInput,
  ProviderPipelineAnthropicMessagesInput,
  ProviderPipelineDecisionInput,
  ProviderPipelineDecisionOutcome,
  ProviderPipelineOpenAIChatCompletionsInput,
  ProviderPipelineOpenAIEmbeddingsInput,
  ProviderPipelineOpenAIImagesEditsInput,
  ProviderPipelineOpenAIImagesGenerationsInput,
  ProviderPipelineOpenAIResponsesInput,
  ProviderPipelineResponsesOutcome,
  ProviderPipelineServices,
  ProviderPipelineStreamOutcome,
  ProviderPipelines,
  UpstreamHttpRequest,
} from '@floway-dev/provider';

interface CopilotPipelinesConfig {
  readonly id: string;
  readonly githubHost: string;
  readonly githubToken: string;
}

type PipelineEnv = StageEnv<ProviderPipelineServices>;
type ChatOutcome = ProviderPipelineStreamOutcome<OpenAIChatCompletionsStreamEvent>;
type ResponsesOutcome = ProviderPipelineResponsesOutcome;
type MessagesOutcome = ProviderPipelineStreamOutcome<AnthropicMessagesStreamEventEx>;

interface WorkFacts {
  readonly 'request.inboundHeaders': readonly HeaderEntry[];
  readonly 'request.payload': object;
  readonly 'provider.model': ProviderModelFacts;
  readonly 'request.action'?: 'generate' | 'compact';
  readonly 'request.anthropicBeta'?: readonly string[];
  readonly 'request.headers'?: readonly HeaderEntry[];
  readonly 'request.rawModel'?: CopilotRawModel;
  readonly 'request.modelKey'?: string;
  readonly 'request.path'?: string;
  readonly 'request.body'?: HttpRequestBody;
  readonly 'request.claudeMetadata'?: ClaudeCodeMetadata;
  readonly 'request.fastMode'?: boolean;
  readonly 'request.omitThinkingText'?: boolean;
}

interface RequestFacts {
  readonly 'request.http': UpstreamHttpRequest;
  readonly 'provider.modelKey': string;
}

const required = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) throw new Error(`Copilot pipeline invariant violated: missing ${label}`);
  return value;
};

const payload = <T>(facts: Readonly<WorkFacts>): T => facts['request.payload'] as T;
const currentHeaders = (facts: Readonly<WorkFacts>): readonly HeaderEntry[] => facts['request.headers'] ?? facts['request.inboundHeaders'];
const modelKey = (facts: Readonly<WorkFacts>): string => required(facts['request.modelKey'], 'request.modelKey');
const requestPath = (facts: Readonly<WorkFacts>): string => required(facts['request.path'], 'request.path');
const requestBody = (facts: Readonly<WorkFacts>): HttpRequestBody => facts['request.body'];

const withModel = <T extends { model: string }>(value: Omit<T, 'model'>, model: string): T => ({ ...value, model }) as T;
const withoutModel = <T extends { model: string }>(value: T): Omit<T, 'model'> => {
  const { model: _model, ...rest } = value;
  return rest;
};

const replaceHeader = (entries: readonly HeaderEntry[], name: string, value: string | HeaderEntry[1]): readonly HeaderEntry[] => Object.freeze([
  ...entries.filter(([existing]) => existing.toLowerCase() !== name.toLowerCase()),
  Object.freeze([name, value] as const),
]);

const applyHeaderStrings = (entries: readonly HeaderEntry[], values: readonly (readonly [string, string])[]): readonly HeaderEntry[] => {
  let result = entries;
  for (const [name, value] of values) result = replaceHeader(result, name, value);
  return result;
};

const finalizeHeaders = (base: readonly HeaderEntry[], overrides: readonly HeaderEntry[]): readonly HeaderEntry[] => {
  const result = new Map(base.map(([name, value]) => [name.toLowerCase(), Object.freeze([name, value] as const)]));
  for (const [name, value] of overrides) {
    if (value === '') result.delete(name.toLowerCase());
    else result.set(name.toLowerCase(), Object.freeze([name, value] as const));
  }
  return Object.freeze([...result.values()]);
};

const selectModelStage = <Out>(
  endpoint: keyof ProviderModelFacts['endpoints'],
  hints: (facts: Readonly<WorkFacts>) => Parameters<typeof rawModelFor>[2],
): Stage<WorkFacts, {
  readonly 'request.rawModel': CopilotRawModel;
  readonly 'request.modelKey': string;
  readonly 'request.headers': readonly HeaderEntry[];
}, Out, Out, never, ProviderPipelineServices> => defineStage({
  name: `select-${endpoint}-model`,
  provides: ['request.rawModel', 'request.modelKey', 'request.headers'],
  execute: async (facts, next) => {
    const rawModel = rawModelFor(facts['provider.model'], endpoint, hints(facts));
    return await next({
      'request.rawModel': rawModel,
      'request.modelKey': rawModel.id,
      'request.headers': wrapSensitiveHeaderEntries(facts['request.inboundHeaders']),
    });
  },
});

const payloadStage = <Out>(
  name: string,
  transform: (value: object, facts: Readonly<WorkFacts>) => object | Promise<object>,
): Stage<WorkFacts, { readonly 'request.payload': object }, Out, Out, never, ProviderPipelineServices> => defineStage({
  name,
  provides: ['request.payload'],
  execute: async (facts, next) => await next({ 'request.payload': await transform(facts['request.payload'], facts) }),
});

const headerStage = <Out>(
  name: string,
  transform: (entries: readonly HeaderEntry[], facts: Readonly<WorkFacts>) => readonly HeaderEntry[] | Promise<readonly HeaderEntry[]>,
): Stage<WorkFacts, { readonly 'request.headers': readonly HeaderEntry[] }, Out, Out, never, ProviderPipelineServices> => defineStage({
  name,
  provides: ['request.headers'],
  execute: async (facts, next) => await next({ 'request.headers': await transform(currentHeaders(facts), facts) }),
});

const anthropicBetaStage = <Out>(
  transform: (facts: Readonly<WorkFacts>) => readonly string[],
): Stage<WorkFacts, { readonly 'request.anthropicBeta': readonly string[] }, Out, Out, never, ProviderPipelineServices> => defineStage({
  name: 'normalize-anthropic-beta',
  provides: ['request.anthropicBeta'],
  execute: async (facts, next) => await next({ 'request.anthropicBeta': transform(facts) }),
});

const requestStage = <Out>(
  name: string,
  path: string | ((facts: Readonly<WorkFacts>) => string),
  body: (facts: Readonly<WorkFacts>) => HttpRequestBody,
): Stage<WorkFacts, { readonly 'request.path': string; readonly 'request.body': HttpRequestBody }, Out, Out, never, ProviderPipelineServices> => defineStage({
  name,
  provides: ['request.path', 'request.body'],
  execute: async (facts, next) => await next({
    'request.path': typeof path === 'string' ? path : path(facts),
    'request.body': body(facts),
  }),
});

const responseStage = <Out>(
  name: string,
  transform: (outcome: Out, facts: Readonly<WorkFacts>, env: PipelineEnv) => Out | Promise<Out>,
): Stage<WorkFacts, Record<never, never>, Out, Out, never, ProviderPipelineServices> => defineStage({
  name,
  execute: async (facts, next, env) => await transform(await next(), facts, env),
});

const tokenFailure = (error: unknown, selectedModel: string, env: PipelineEnv): HttpOutcome => {
  if (!isCopilotTokenFetchError(error)) throw error;
  const now = env.clock();
  return {
    status: error.status,
    statusText: '',
    headers: wrapSensitiveHeaderEntries([...error.headers.entries()]),
    body: bytesToManagedStream(new TextEncoder().encode(error.body), env),
    modelKey: selectedModel,
    timing: { startedAtMs: now, headersAtMs: now },
  };
};

const copilotHttpStage = <Out>(
  copilot: CopilotPipelinesConfig,
  finish: (http: HttpOutcome, facts: Readonly<WorkFacts>, selectedModel: string, env: PipelineEnv) => Promise<Out> | Out,
): Stage<WorkFacts, RequestFacts, HttpOutcome, Out, never, ProviderPipelineServices> => defineStage({
  name: 'copilot.authenticate',
  provides: ['request.http', 'provider.modelKey'],
  execute: async (facts, next, env) => {
    const selectedModel = modelKey(facts);
    let entry;
    try {
      entry = await ensureCopilotToken(copilot.id, copilot.githubHost, copilot.githubToken, env.fetcherFor(copilot.id), env.signal);
    } catch (error) {
      return await finish(tokenFailure(error, selectedModel, env), facts, selectedModel, env);
    }

    const http = await next({
      'request.http': {
        method: 'POST',
        url: buildWireHttpUrl(entry.baseUrl, requestPath(facts)),
        headers: finalizeHeaders(
          copilotBaseHeaderEntries({ token: entry.token, requestId: crypto.randomUUID() }),
          currentHeaders(facts),
        ),
        body: requestBody(facts),
      },
      'provider.modelKey': selectedModel,
    });
    captureQuotaFireAndForget(copilot.id, headersFromEntries(http.headers), env.waitUntil);
    return await finish(http, facts, selectedModel, env);
  },
});

const parseResponsesHttp = async (
  http: HttpOutcome,
  facts: Readonly<WorkFacts>,
  selectedModel: string,
  env: PipelineEnv,
): Promise<ResponsesOutcome> => {
  if (facts['request.action'] === 'compact') {
    if (http.status < 200 || http.status >= 300) return { action: 'compact', ok: false, modelKey: selectedModel, http };
    const generated = JSON.parse(new TextDecoder().decode(await readManagedBytes(http.body))) as OpenAIResponsesResultEx;
    return {
      action: 'compact',
      ok: true,
      result: compactionResponse(payload<CanonicalOpenAIResponsesPayload>(facts).input, generated),
      modelKey: selectedModel,
      http: {
        status: http.status,
        statusText: http.statusText,
        headers: http.headers,
        timing: http.timing,
      },
    };
  }
  return { action: 'generate', ...await parseUpstreamSseOutcome(http, parseOpenAIResponsesStream, env) };
};

const itemIdMembraneStage = defineStage<
  WorkFacts,
  { readonly 'request.payload': object },
  ResponsesOutcome,
  ResponsesOutcome,
  never,
  ProviderPipelineServices
>({
  name: 'item-id-membrane',
  provides: ['request.payload'],
  execute: async (facts, next, env) => {
    const outcome = await next({
      'request.payload': withoutModel(restoreCopilotOpenAIResponsesInputItemIds(payload<CanonicalOpenAIResponsesPayload>(facts))),
    });
    if (!outcome.ok) return outcome;
    if (outcome.action === 'compact') {
      return { ...outcome, result: normalizeCopilotOpenAIResponsesCompactionResult(outcome.result) };
    }
    return {
      ...outcome,
      events: env.wrapStream(outcome.events, {
        label: 'protocol.events',
        transform: source => normalizeCopilotOpenAIResponsesFrames(source),
      }),
    };
  },
});

const abortResponsesStage = responseStage<ResponsesOutcome>('abort-on-tool-argument-whitespace', (outcome, _facts, env) => {
  if (outcome.action !== 'generate' || !outcome.ok) return outcome;
  return {
    ...outcome,
    events: env.wrapStream(outcome.events, {
      label: 'protocol.events',
      transform: source => abortCopilotOpenAIResponsesToolArgumentWhitespace(source),
    }),
  };
});

const fastGateStage: Stage<WorkFacts, Record<never, never>, MessagesOutcome, MessagesOutcome, never, ProviderPipelineServices> = defineStage({
  name: 'handle-speed-fast-gate',
  execute: async (facts, next, env) => {
    const body = payload<Omit<AnthropicMessagesPayload, 'model'>>(facts);
    if (body.speed !== 'fast' || copilotModelHasFastVariant(facts['provider.model'])) return await next();
    // Anthropic Fast Mode is a hard request-side contract, unlike the OpenAI
    // priority lane where the upstream may report a standard fallback.
    // https://docs.claude.com/en/build-with-claude/fast-mode
    // https://docs.claude.com/en/api/service-tiers
    // https://github.com/Yeachan-Heo/gajae-code/blob/main/packages/ai/test/anthropic-fast-mode.test.ts
    return {
      ok: false,
      modelKey: facts['provider.model'].id,
      http: syntheticJsonOutcome(env, {
        status: 400,
        modelKey: facts['provider.model'].id,
        body: {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: `'${facts['provider.model'].id}' does not support the \`speed\` parameter.`,
          },
        },
      }),
    };
  },
});

const detectClaudeMetadataStage: Stage<
  WorkFacts,
  { readonly 'request.claudeMetadata': ClaudeCodeMetadata },
  MessagesOutcome,
  MessagesOutcome,
  never,
  ProviderPipelineServices
> = defineStage({
  name: 'detect-claude-code-metadata',
  provides: ['request.claudeMetadata'],
  execute: async (facts, next) => await next({
    'request.claudeMetadata': parseUserIdMetadata(payload<Omit<AnthropicMessagesPayload, 'model'>>(facts).metadata?.user_id ?? undefined),
  }),
});

const fastSpeedFrames = async function* (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEventEx>> {
  for await (const frame of frames) {
    if (frame.type === 'event' && frame.event.type === 'message_start') {
      yield eventFrame({
        ...frame.event,
        message: {
          ...frame.event.message,
          usage: { ...frame.event.message.usage, speed: 'fast' },
        },
      });
    } else {
      yield frame;
    }
  }
};

const speedFastStage: Stage<
  WorkFacts,
  { readonly 'request.payload': object; readonly 'request.fastMode': boolean },
  MessagesOutcome,
  MessagesOutcome,
  never,
  ProviderPipelineServices
> = defineStage({
  name: 'handle-speed-fast',
  provides: ['request.payload', 'request.fastMode'],
  execute: async (facts, next, env) => {
    const body = payload<Omit<AnthropicMessagesPayload, 'model'>>(facts);
    const fast = body.speed === 'fast';
    const nextBody = body.speed === 'fast' || body.speed === 'standard'
      ? (() => {
          const { speed: _speed, ...rest } = body;
          return rest;
        })()
      : body;
    const outcome = await next({ 'request.payload': nextBody, 'request.fastMode': fast });
    if (!fast || !outcome.ok) return outcome;
    return {
      ...outcome,
      events: env.wrapStream(outcome.events, {
        label: 'protocol.events',
        transform: source => fastSpeedFrames(source),
      }),
    };
  },
});

const thinkingDisplayStage: Stage<
  WorkFacts,
  { readonly 'request.payload': object; readonly 'request.omitThinkingText': boolean },
  MessagesOutcome,
  MessagesOutcome,
  never,
  ProviderPipelineServices
> = defineStage({
  name: 'promote-thinking-display',
  provides: ['request.payload', 'request.omitThinkingText'],
  execute: async (facts, next, env) => {
    const promoted = promoteCopilotThinkingDisplay(withModel<AnthropicMessagesPayload>(payload(facts), facts['provider.model'].id));
    const outcome = await next({
      'request.payload': withoutModel(promoted.payload),
      'request.omitThinkingText': promoted.omitThinkingText,
    });
    if (!outcome.ok || !promoted.omitThinkingText) return outcome;
    return {
      ...outcome,
      events: env.wrapStream(outcome.events, {
        label: 'protocol.events',
        transform: source => omitPromotedThinkingTextFromProtocolFrames(source),
      }),
    };
  },
});

const rewriteContextWindowStage: Stage<WorkFacts, Record<never, never>, MessagesOutcome, MessagesOutcome, never, ProviderPipelineServices> = defineStage({
  name: 'rewrite-context-window-error',
  execute: async (_facts, next, env) => {
    const outcome = await next();
    if (outcome.ok) return outcome;
    const bytes = await readManagedBytes(outcome.http.body);
    if (!isCopilotContextWindowError(new TextDecoder().decode(bytes))) {
      return { ...outcome, http: { ...outcome.http, body: bytesToManagedStream(bytes, env) } };
    }
    return {
      ...outcome,
      http: {
        ...outcome.http,
        status: 400,
        headers: wrapSensitiveHeaderEntries([['content-type', 'application/json']]),
        body: bytesToManagedStream(buildPromptTooLongBody(), env),
      },
    };
  },
});

const setChatVision = headerStage<ChatOutcome>('set-vision-header', (entries, facts) => {
  const body = withModel<OpenAIChatCompletionsPayloadEx>(payload<Omit<OpenAIChatCompletionsPayloadEx, 'model'>>(facts), facts['provider.model'].id);
  return copilotOpenAIChatCompletionsHasImage(body) ? replaceHeader(entries, 'copilot-vision-request', 'true') : entries;
});

const setChatInitiator = headerStage<ChatOutcome>('set-initiator-header', (entries, facts) => replaceHeader(
  entries,
  'x-initiator',
  copilotOpenAIChatCompletionsInitiator(withModel<OpenAIChatCompletionsPayloadEx>(payload<Omit<OpenAIChatCompletionsPayloadEx, 'model'>>(facts), facts['provider.model'].id)),
));

const setResponsesVision = headerStage<ResponsesOutcome>('set-vision-header', (entries, facts) => {
  const body = withModel<CanonicalOpenAIResponsesPayload>(payload<Omit<CanonicalOpenAIResponsesPayload, 'model'>>(facts), facts['provider.model'].id);
  return copilotOpenAIResponsesHasImage(body) ? replaceHeader(entries, 'copilot-vision-request', 'true') : entries;
});

const setResponsesInitiator = headerStage<ResponsesOutcome>('set-initiator-header', (entries, facts) => replaceHeader(
  entries,
  'x-initiator',
  copilotOpenAIResponsesInitiator(withModel<CanonicalOpenAIResponsesPayload>(payload<Omit<CanonicalOpenAIResponsesPayload, 'model'>>(facts), facts['provider.model'].id)),
));

const anthropicInitiator = (body: AnthropicMessagesPayload): 'user' | 'agent' => {
  const last = body.messages.at(-1);
  if (last?.role !== 'user') return 'agent';
  if (!Array.isArray(last.content)) return 'user';
  return last.content.some(block => block.type !== 'tool_result') ? 'user' : 'agent';
};

const setMessagesVision = headerStage<MessagesOutcome>('set-vision-header', (entries, facts) => {
  const body = withModel<AnthropicMessagesPayload>(payload<Omit<AnthropicMessagesPayload, 'model'>>(facts), facts['provider.model'].id);
  return body.messages.some(message => copilotAnthropicContentHasImage(message.content))
    ? replaceHeader(entries, 'copilot-vision-request', 'true')
    : entries;
});

const setMessagesInitiator = headerStage<MessagesOutcome>('set-initiator-header', (entries, facts) => replaceHeader(
  entries,
  'x-initiator',
  anthropicInitiator(withModel<AnthropicMessagesPayload>(payload<Omit<AnthropicMessagesPayload, 'model'>>(facts), facts['provider.model'].id)),
));

const setClaudeAgentHeaders = headerStage<MessagesOutcome>('set-claude-agent-headers', (entries, facts) => {
  const overrides = copilotClaudeAgentHeaderOverrides(withModel<AnthropicMessagesPayload>(payload<Omit<AnthropicMessagesPayload, 'model'>>(facts), facts['provider.model'].id));
  return overrides === null ? entries : applyHeaderStrings(entries, Object.entries(overrides));
});

const setInteractionIdHeader = headerStage<MessagesOutcome>('set-interaction-id-header', async (entries, facts) => {
  const sessionId = facts['request.claudeMetadata']?.sessionId;
  return sessionId ? replaceHeader(entries, 'x-interaction-id', await copilotSessionUuid(sessionId)) : entries;
});

const setCompactHeaders = headerStage<MessagesOutcome>('set-compact-headers', (entries, facts) => {
  const compactHeaders = new Headers();
  applyCopilotCompactHeaders(
    classifyCopilotCompact(withModel<AnthropicMessagesPayload>(payload<Omit<AnthropicMessagesPayload, 'model'>>(facts), facts['provider.model'].id)),
    compactHeaders,
  );
  return applyHeaderStrings(entries, [...compactHeaders.entries()]);
});

const setAnthropicBetaHeader = <Out>() => headerStage<Out>('anthropic-beta', (entries, facts) => {
  const ordinary = entries.filter(([name]) => name.toLowerCase() !== 'anthropic-beta');
  const beta = facts['request.anthropicBeta'] ?? [];
  return beta.length === 0
    ? Object.freeze(ordinary)
    : Object.freeze([...ordinary, Object.freeze(['anthropic-beta', beta.join(',')] as const)]);
});

const setCountTokensVision = headerStage<HttpOutcome>('set-vision-header', (entries, facts) => {
  const body = withModel<AnthropicMessagesPayload>(payload<Omit<AnthropicMessagesPayload, 'model'>>(facts), facts['provider.model'].id);
  return body.messages.some(message => copilotAnthropicContentHasImage(message.content))
    ? replaceHeader(entries, 'copilot-vision-request', 'true')
    : entries;
});

const setCountTokensInitiator = headerStage<HttpOutcome>('set-initiator-header', (entries, facts) => replaceHeader(
  entries,
  'x-initiator',
  anthropicInitiator(withModel<AnthropicMessagesPayload>(payload<Omit<AnthropicMessagesPayload, 'model'>>(facts), facts['provider.model'].id)),
));

const makePipeline = <Input extends object, Out>(
  copilot: CopilotPipelinesConfig,
  name: string,
  stages: readonly AnyStage[],
): Pipeline<Input, Out, ProviderPipelineServices> => Object.freeze({
  name,
  stages: Object.freeze([...stages]),
  ending: httpTerminal(copilot.id) as unknown as Ending<any, Out, any>,
});

const buildChatPipeline = (copilot: CopilotPipelinesConfig): Pipeline<ProviderPipelineOpenAIChatCompletionsInput, ChatOutcome, ProviderPipelineServices> => makePipeline(
  copilot,
  'copilot.openai-chat-completions',
  [
    selectModelStage<ChatOutcome>('openaiChatCompletions', facts => ({
      reasoningEffort: chatReasoningEffort(payload<Omit<OpenAIChatCompletionsPayloadEx, 'model'>>(facts)),
    })),
    payloadStage<ChatOutcome>('compress-images', async (body, facts) => withoutModel(
      await compressCopilotOpenAIChatCompletionsImages(
        withModel<OpenAIChatCompletionsPayloadEx>(body as Omit<OpenAIChatCompletionsPayloadEx, 'model'>, facts['provider.model'].id),
        facts['provider.model'],
      ),
    )),
    payloadStage<ChatOutcome>('attach-cache-control-markers', (body, facts) => withoutModel(
      attachCopilotCacheControlMarkers(withModel<OpenAIChatCompletionsPayloadEx>(body as Omit<OpenAIChatCompletionsPayloadEx, 'model'>, facts['provider.model'].id)),
    )),
    setChatVision,
    setChatInitiator,
    requestStage<ChatOutcome>('openai-chat-completions.request', '/chat/completions', facts => ({
      kind: 'json',
      value: { ...payload(facts), stream: true, model: modelKey(facts) },
    })),
    responseStage<ChatOutcome>('abort-on-tool-argument-whitespace', (outcome, _facts, env) => outcome.ok
      ? {
          ...outcome,
          events: env.wrapStream(outcome.events, {
            label: 'protocol.events',
            transform: source => abortCopilotOpenAIChatCompletionsToolArgumentWhitespace(source),
          }),
        }
      : outcome),
    copilotHttpStage(copilot, async (http, _facts, _selectedModel, env) =>
      await parseUpstreamSseOutcome(http, parseOpenAIChatCompletionsStream, env)),
  ],
);

const buildResponsesPipeline = (copilot: CopilotPipelinesConfig): Pipeline<ProviderPipelineOpenAIResponsesInput, ResponsesOutcome, ProviderPipelineServices> => makePipeline(
  copilot,
  'copilot.openai-responses',
  [
    selectModelStage<ResponsesOutcome>('openaiResponses', facts => {
      const body = payload<Omit<CanonicalOpenAIResponsesPayload, 'model'>>(facts);
      return {
        reasoningEffort: openaiResponsesReasoningEffort(body),
        fast: isFastServiceTier(body.service_tier),
      };
    }),
    payloadStage<ResponsesOutcome>('compress-images', async (body, facts) => withoutModel(
      await compressCopilotOpenAIResponsesImages(
        withModel<CanonicalOpenAIResponsesPayload>(body as Omit<CanonicalOpenAIResponsesPayload, 'model'>, facts['provider.model'].id),
        facts['provider.model'],
      ),
    )),
    payloadStage<ResponsesOutcome>('fill-empty-namespace-descriptions', (body, facts) => withoutModel(
      fillCopilotEmptyNamespaceDescriptions(withModel<CanonicalOpenAIResponsesPayload>(body as Omit<CanonicalOpenAIResponsesPayload, 'model'>, facts['provider.model'].id)),
    )),
    payloadStage<ResponsesOutcome>('strip-service-tier', (body, facts) => withoutModel(
      stripCopilotServiceTier(withModel<CanonicalOpenAIResponsesPayload>(body as Omit<CanonicalOpenAIResponsesPayload, 'model'>, facts['provider.model'].id)),
    )),
    payloadStage<ResponsesOutcome>('strip-image-generation', (body, facts) => withoutModel(
      stripCopilotImageGeneration(withModel<CanonicalOpenAIResponsesPayload>(body as Omit<CanonicalOpenAIResponsesPayload, 'model'>, facts['provider.model'].id)),
    )),
    itemIdMembraneStage,
    abortResponsesStage,
    setResponsesVision,
    setResponsesInitiator,
    requestStage<ResponsesOutcome>('openai-responses.request', '/responses', facts => ({
      kind: 'json',
      value: facts['request.action'] === 'compact'
        ? {
            ...payload(facts),
            input: [...payload<CanonicalOpenAIResponsesPayload>(facts).input, COMPACTION_TRIGGER],
            stream: false,
            model: modelKey(facts),
          }
        : { ...payload(facts), stream: true, model: modelKey(facts) },
    })),
    copilotHttpStage(copilot, parseResponsesHttp),
  ],
);

const buildMessagesPipeline = (copilot: CopilotPipelinesConfig): Pipeline<ProviderPipelineAnthropicMessagesInput, MessagesOutcome, ProviderPipelineServices> => makePipeline(
  copilot,
  'copilot.anthropic-messages',
  [
    fastGateStage,
    selectModelStage<MessagesOutcome>('anthropicMessages', facts => ({
      context1m: (facts['request.anthropicBeta'] ?? []).includes(CONTEXT_1M_BETA),
      reasoningEffort: anthropicMessagesReasoningEffort(payload<Omit<AnthropicMessagesPayload, 'model'>>(facts)),
      fast: payload<Omit<AnthropicMessagesPayload, 'model'>>(facts).speed === 'fast',
    })),
    detectClaudeMetadataStage,
    rewriteContextWindowStage,
    setCompactHeaders,
    setClaudeAgentHeaders,
    setInteractionIdHeader,
    payloadStage<MessagesOutcome>('compress-images', async (body, facts) => withoutModel(
      await compressCopilotAnthropicMessagesImages(
        withModel<AnthropicMessagesPayload>(body as Omit<AnthropicMessagesPayload, 'model'>, facts['provider.model'].id),
        facts['provider.model'],
      ),
    )),
    speedFastStage,
    thinkingDisplayStage,
    payloadStage<MessagesOutcome>('apply-top-level-cache-control', (body, facts) => withoutModel(
      applyCopilotTopLevelCacheControl(withModel<AnthropicMessagesPayload>(body as Omit<AnthropicMessagesPayload, 'model'>, facts['provider.model'].id)),
    )),
    payloadStage<MessagesOutcome>('strip-cache-control-extensions', (body, facts) => withoutModel(
      stripCopilotCacheControlExtensions(withModel<AnthropicMessagesPayload>(body as Omit<AnthropicMessagesPayload, 'model'>, facts['provider.model'].id)),
    )),
    payloadStage<MessagesOutcome>('strip-eager-input-streaming', (body, facts) => withoutModel(
      stripCopilotEagerInputStreaming(withModel<AnthropicMessagesPayload>(body as Omit<AnthropicMessagesPayload, 'model'>, facts['provider.model'].id)),
    )),
    setMessagesVision,
    setMessagesInitiator,
    anthropicBetaStage<MessagesOutcome>(facts => normalizeCopilotAnthropicBeta(
      facts['request.anthropicBeta'] ?? [],
      withModel<AnthropicMessagesPayload>(payload(facts), facts['provider.model'].id),
    )),
    setAnthropicBetaHeader<MessagesOutcome>(),
    requestStage<MessagesOutcome>('anthropic-messages.request', '/v1/messages', facts => ({
      kind: 'json',
      value: { ...payload(facts), stream: true, model: modelKey(facts) },
    })),
    copilotHttpStage(copilot, async (http, _facts, _selectedModel, env) =>
      await parseUpstreamSseOutcome(http, parseAnthropicMessagesStream, env)),
  ],
);

const buildCountTokensPipeline = (copilot: CopilotPipelinesConfig): Pipeline<ProviderPipelineAnthropicMessagesCountTokensInput, HttpOutcome, ProviderPipelineServices> => makePipeline(
  copilot,
  'copilot.anthropic-messages-count-tokens',
  [
    selectModelStage<HttpOutcome>('anthropicMessages', facts => ({
      context1m: (facts['request.anthropicBeta'] ?? []).includes(CONTEXT_1M_BETA),
      reasoningEffort: anthropicMessagesReasoningEffort(payload<Omit<AnthropicMessagesPayload, 'model'>>(facts)),
    })),
    payloadStage<HttpOutcome>('compress-images', async (body, facts) => withoutModel(
      await compressCopilotAnthropicMessagesImages(
        withModel<AnthropicMessagesPayload>(body as Omit<AnthropicMessagesPayload, 'model'>, facts['provider.model'].id),
        facts['provider.model'],
      ),
    )),
    setCountTokensVision,
    setCountTokensInitiator,
    anthropicBetaStage<HttpOutcome>(facts => normalizeCopilotAnthropicBeta(
      facts['request.anthropicBeta'] ?? [],
      withModel<AnthropicMessagesPayload>(payload(facts), facts['provider.model'].id),
    )),
    setAnthropicBetaHeader<HttpOutcome>(),
    requestStage<HttpOutcome>('anthropic-messages-count-tokens.request', '/v1/messages/count_tokens', facts => ({
      kind: 'json',
      value: { ...payload(facts), model: modelKey(facts) },
    })),
    copilotHttpStage(copilot, async (http, _facts, _selectedModel) => http),
  ],
);

const buildEmbeddingsPipeline = (copilot: CopilotPipelinesConfig): Pipeline<ProviderPipelineOpenAIEmbeddingsInput, HttpOutcome, ProviderPipelineServices> => makePipeline(
  copilot,
  'copilot.openai-embeddings',
  [
    selectModelStage<HttpOutcome>('openaiEmbeddings', () => ({})),
    payloadStage<HttpOutcome>('openai-embeddings-input', body => copilotOpenAIEmbeddingsBody(body as Record<string, unknown>)),
    requestStage<HttpOutcome>('openai-embeddings.request', '/embeddings', facts => ({
      kind: 'json',
      value: { ...payload(facts), model: modelKey(facts) },
    })),
    copilotHttpStage(copilot, async (http, _facts, _selectedModel) => http),
  ],
);

const buildImagesGenerationsPipeline = (copilot: CopilotPipelinesConfig): Pipeline<ProviderPipelineOpenAIImagesGenerationsInput, HttpOutcome, ProviderPipelineServices> => makePipeline(
  copilot,
  'copilot.openai-images-generations',
  [
    selectModelStage<HttpOutcome>('openaiImagesGenerations', () => ({})),
    requestStage<HttpOutcome>('openai-images-generations.request', '/v1/images/generations', facts => ({
      kind: 'json',
      value: { ...payload(facts), model: modelKey(facts) },
    })),
    copilotHttpStage(copilot, async (http, _facts, _selectedModel) => http),
  ],
);

const buildImagesEditsPipeline = (copilot: CopilotPipelinesConfig): Pipeline<ProviderPipelineOpenAIImagesEditsInput, HttpOutcome, ProviderPipelineServices> => makePipeline(
  copilot,
  'copilot.openai-images-edits',
  [
    selectModelStage<HttpOutcome>('openaiImagesEdits', () => ({})),
    defineStage<
      WorkFacts,
      { readonly 'request.path': string; readonly 'request.body': HttpRequestBody },
      HttpOutcome,
      HttpOutcome,
      never,
      ProviderPipelineServices
    >({
      name: 'openai-images-edits.request',
      provides: ['request.path', 'request.body'],
      execute: async (facts, next) => await next({
        'request.path': '/v1/images/edits',
        'request.body': buildImagesEditsHttpBody(payload(facts) as never, modelKey(facts)),
      }),
    }),
    copilotHttpStage(copilot, async (http, _facts, _selectedModel) => http),
  ],
);

const decisionRequestStage: Stage<
  WorkFacts,
  { readonly 'request.path': string; readonly 'request.body': HttpRequestBody },
  ProviderPipelineDecisionOutcome,
  ProviderPipelineDecisionOutcome,
  never,
  ProviderPipelineServices
> = defineStage({
  name: 'decision.request',
  provides: ['request.path', 'request.body'],
  execute: async (facts, next) => {
    const target = facts['provider.model'].decisionTarget;
    if (target === undefined) throw new Error(`Decision model ${facts['provider.model'].id} has no outbound target`);
    return await next({
      'request.path': target.path ?? DEFAULT_DECISION_PATHS[target.protocol],
      'request.body': Object.freeze({
        kind: 'json',
        value: serializeDecisionRequest(target.protocol, modelKey(facts), payload(facts) as never),
      } as const),
    });
  },
});

const decisionFinish = (http: HttpOutcome, facts: Readonly<WorkFacts>, selectedModel: string): ProviderPipelineDecisionOutcome => {
  const target: DecisionTarget | undefined = facts['provider.model'].decisionTarget;
  if (target === undefined) throw new Error(`Decision model ${facts['provider.model'].id} has no outbound target`);
  return { target, modelKey: selectedModel, http };
};

const buildDecisionPipeline = (copilot: CopilotPipelinesConfig): Pipeline<ProviderPipelineDecisionInput, ProviderPipelineDecisionOutcome, ProviderPipelineServices> => makePipeline(
  copilot,
  'copilot.decision',
  [
    selectModelStage<ProviderPipelineDecisionOutcome>('decision', () => ({})),
    decisionRequestStage,
    copilotHttpStage(copilot, decisionFinish),
  ],
);

export const createCopilotPipelines = (copilot: CopilotPipelinesConfig): ProviderPipelines => ({
  openaiChatCompletions: buildChatPipeline(copilot),
  openaiResponses: buildResponsesPipeline(copilot),
  anthropicMessages: buildMessagesPipeline(copilot),
  anthropicMessagesCountTokens: buildCountTokensPipeline(copilot),
  openaiEmbeddings: buildEmbeddingsPipeline(copilot),
  openaiImagesGenerations: buildImagesGenerationsPipeline(copilot),
  openaiImagesEdits: buildImagesEditsPipeline(copilot),
  decision: buildDecisionPipeline(copilot),
});
