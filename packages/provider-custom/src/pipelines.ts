import type { CustomAuthStyle, CustomUpstreamConfig } from './config.ts';
import { appendPathSegment, customPathFor } from './paths.ts';
import { defineRequestStage, defineStage, pipeline, secret } from '@floway-dev/pipeline';
import type { HeaderEntry, Pipeline, Secret, StageEnv } from '@floway-dev/pipeline';
import { parseAnthropicMessagesStream, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest } from '@floway-dev/protocols/decision';
import { parseGeminiGenerateContentStream, type GeminiCountTokensPayload, type GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { parseOpenAIChatCompletionsStream, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream, toCompactPayloadShape, type OpenAIResponsesCompactionResultEx } from '@floway-dev/protocols/openai-responses';
import { DEFAULT_RERANK_PATHS, serializeRerankRequest } from '@floway-dev/protocols/rerank';
import {
  buildAudioTranscriptionMultipartBody,
  buildImagesEditsHttpBody,
  buildWireHttpUrl,
  httpTerminal,
  parseUpstreamSseOutcome,
  readManagedBytes,
  type HttpOutcome,
  type HttpRequestBody,
  type ProviderModelFacts,
  type ProviderPipelineAlphaSearchInput,
  type ProviderPipelineAnthropicMessagesCountTokensInput,
  type ProviderPipelineAnthropicMessagesInput,
  type ProviderPipelineCompactionOutcome,
  type ProviderPipelineDecisionInput,
  type ProviderPipelineDecisionOutcome,
  type ProviderPipelineGeminiGenerateContentCountTokensInput,
  type ProviderPipelineGeminiGenerateContentInput,
  type ProviderPipelineOpenAIAudioTranscriptionsInput,
  type ProviderPipelineOpenAIChatCompletionsInput,
  type ProviderPipelineOpenAICompletionsInput,
  type ProviderPipelineOpenAIEmbeddingsInput,
  type ProviderPipelineOpenAIImagesEditsInput,
  type ProviderPipelineOpenAIImagesGenerationsInput,
  type ProviderPipelineOpenAIResponsesInput,
  type ProviderPipelineRerankInput,
  type ProviderPipelineRerankOutcome,
  type ProviderPipelineResponsesOutcome,
  type ProviderPipelineServices,
  type ProviderPipelineStreamOutcome,
  type ProviderPipelines,
  type ProviderStreamParser,
  type UpstreamHttpRequest,
} from '@floway-dev/provider';

// https://docs.anthropic.com/en/api/versioning
const ANTHROPIC_VERSION = '2023-06-01';

interface UpstreamFacts {
  readonly 'request.inboundHeaders': readonly HeaderEntry[];
  readonly 'provider.model': ProviderModelFacts;
}

interface RequestFacts {
  readonly 'request.http': UpstreamHttpRequest;
  readonly 'provider.modelKey'?: string;
}

const rawModelIdOf = (facts: Readonly<UpstreamFacts>): string => facts['provider.model'].upstreamModelId;

const authHeaders = (config: CustomUpstreamConfig, auth: CustomAuthStyle): readonly HeaderEntry[] => {
  if (config.apiKey === '') return [];
  if (auth === 'bearer') {
    return [Object.freeze(['authorization', secret(`Bearer ${config.apiKey}`)] as const)];
  }
  if (auth === 'x-api-key') {
    return [
      Object.freeze(['x-api-key', secret(config.apiKey)] as const),
      Object.freeze(['anthropic-version', ANTHROPIC_VERSION] as const),
    ];
  }
  return [Object.freeze(['x-goog-api-key', secret(config.apiKey)] as const)];
};

const ingressHeaders = (config: CustomUpstreamConfig, inbound: readonly HeaderEntry[]): readonly HeaderEntry[] => {
  const valuesByKey = new Map<string, Array<string | null>>();
  for (const rule of config.ingressHeadersRules) {
    const values = valuesByKey.get(rule.key);
    if (values === undefined) valuesByKey.set(rule.key, [rule.value]);
    else values.push(rule.value);
  }

  const admitted = new Map<string, { readonly values: string[]; readonly hadSecret: boolean }>();
  for (const [name, value] of inbound) {
    const key = name.toLowerCase();
    if (!valuesByKey.has(key)) continue;
    const entry = admitted.get(key) ?? { values: [], hadSecret: false };
    entry.values.push(typeof value === 'string' ? value : value.reveal());
    admitted.set(key, { values: entry.values, hadSecret: entry.hadSecret || typeof value !== 'string' });
  }

  const resolved: HeaderEntry[] = inbound
    .filter(([name]) => !valuesByKey.has(name.toLowerCase()))
    .map(([name, value]) => Object.freeze([name, value] as const));
  for (const [key, values] of valuesByKey) {
    const inboundValue = admitted.get(key);
    const joined = inboundValue?.values.join(', ');
    for (const value of values) {
      if (value !== null) {
        // Any configured value can be a vendor credential regardless of its
        // arbitrary header name, so it must never enter a dump as plaintext.
        resolved.push(Object.freeze([key, secret(value)] as const));
      } else if (joined !== undefined) {
        resolved.push(Object.freeze([key, inboundValue?.hadSecret ? secret(joined) : joined] as const));
      }
    }
  }
  return Object.freeze(resolved);
};

// Caller field lines replace the transport's own values for a name while
// retaining the caller's line order and repetitions.
const replaceHeaderNames = (base: readonly HeaderEntry[], caller: readonly HeaderEntry[]): readonly HeaderEntry[] => {
  const replaced = new Set(caller.map(([name]) => name.toLowerCase()));
  return Object.freeze([
    ...base.filter(([name]) => !replaced.has(name.toLowerCase())),
    ...caller,
  ]);
};

const anthropicTypedHeaders = (ordinary: readonly HeaderEntry[], beta: readonly string[]): readonly HeaderEntry[] =>
  replaceHeaderNames(ordinary, beta.length === 0 ? [] : [Object.freeze(['anthropic-beta', beta.join(',')] as const)]);

const requestBuilder = <Input extends UpstreamFacts>(options: {
  readonly config: CustomUpstreamConfig;
  readonly auth: CustomAuthStyle;
  readonly path: string;
  readonly extraQuery?: ReadonlyArray<readonly [string, string | Secret<string>]>;
  readonly body?: HttpRequestBody;
  readonly modelKey?: string;
  readonly headers?: (facts: Readonly<Input>, resolved: readonly HeaderEntry[]) => readonly HeaderEntry[];
}): (facts: Readonly<Input>) => RequestFacts => facts => {
  const callerHeaders = ingressHeaders(options.config, facts['request.inboundHeaders']);
  const mixed = replaceHeaderNames(authHeaders(options.config, options.auth), callerHeaders);
  const headers = options.headers === undefined ? mixed : options.headers(facts, mixed);
  return Object.freeze({
    'request.http': Object.freeze({
      method: 'POST',
      url: buildWireHttpUrl(options.config.baseUrl, options.path, options.extraQuery),
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
    }),
    ...(options.modelKey === undefined ? {} : { 'provider.modelKey': options.modelKey }),
  });
};

const requestStage = <Input extends UpstreamFacts>(name: string, build: (facts: Readonly<Input>) => RequestFacts) =>
  defineRequestStage<Input, RequestFacts, never, ProviderPipelineServices>({
    name,
    provides: ['request.http', 'provider.modelKey'],
    execute: async (facts, next) => await next(build(facts)),
  });

const httpPipeline = <Input extends UpstreamFacts>(
  upstreamId: string,
  name: string,
  build: (facts: Readonly<Input>) => RequestFacts,
): Pipeline<Input, HttpOutcome, ProviderPipelineServices> => {
  const stage = requestStage(`${name}.request`, build);
  return pipeline<Input>(name)
    .use<typeof stage>(stage as never)
    .end(httpTerminal(upstreamId));
};

const exchangePipeline = <Input extends UpstreamFacts, Out>(
  upstreamId: string,
  name: string,
  build: (facts: Readonly<Input>) => RequestFacts,
  exchange: (
    http: HttpOutcome,
    facts: Readonly<Input>,
    env: StageEnv<ProviderPipelineServices>,
  ) => Promise<Out>,
): Pipeline<Input, Out, ProviderPipelineServices> => {
  const stage = defineStage<Input, RequestFacts, HttpOutcome, Out, never, ProviderPipelineServices>({
    name: `${name}.exchange`,
    provides: ['request.http', 'provider.modelKey'],
    execute: async (facts, next, env) => {
      const http = await next(build(facts));
      return await exchange(http, facts, env);
    },
  });
  return pipeline<Input>(name)
    .use<typeof stage>(stage as never)
    .end(httpTerminal(upstreamId));
};

const ssePipeline = <Input extends UpstreamFacts, Event>(
  upstreamId: string,
  name: string,
  build: (facts: Readonly<Input>) => RequestFacts,
  parser: ProviderStreamParser<Event>,
): Pipeline<Input, ProviderPipelineStreamOutcome<Event>, ProviderPipelineServices> => {
  return exchangePipeline(upstreamId, name, build, async (http, _facts, env) =>
    await parseUpstreamSseOutcome(http, parser, env));
};

const jsonBody = (payload: object, model: string): Record<string, unknown> => ({ ...payload, model });

export const createCustomPipelines = (upstreamId: string, config: CustomUpstreamConfig): ProviderPipelines => {
  return {
    alphaSearch: httpPipeline<ProviderPipelineAlphaSearchInput>(
      upstreamId,
      `${upstreamId}.alphaSearch`,
      facts => requestBuilder<ProviderPipelineAlphaSearchInput>({
        config,
        auth: 'bearer',
        path: customPathFor(config, '/alpha/search'),
        body: { kind: 'json', value: jsonBody(facts['request.payload'], rawModelIdOf(facts)) },
        modelKey: rawModelIdOf(facts),
      })(facts),
    ),
    openaiCompletions: httpPipeline<ProviderPipelineOpenAICompletionsInput>(
      upstreamId,
      `${upstreamId}.openaiCompletions`,
      facts => requestBuilder<ProviderPipelineOpenAICompletionsInput>({
        config,
        auth: 'bearer',
        path: customPathFor(config, '/completions'),
        body: { kind: 'json', value: jsonBody(facts['request.payload'], rawModelIdOf(facts)) },
        modelKey: rawModelIdOf(facts),
      })(facts),
    ),
    openaiChatCompletions: ssePipeline<ProviderPipelineOpenAIChatCompletionsInput, OpenAIChatCompletionsStreamEvent>(
      upstreamId,
      `${upstreamId}.openaiChatCompletions`,
      facts => requestBuilder({
        config,
        auth: 'bearer',
        path: customPathFor(config, '/chat/completions'),
        body: { kind: 'json', value: { ...jsonBody(facts['request.payload'], rawModelIdOf(facts)), stream: true } },
        modelKey: rawModelIdOf(facts),
      })(facts),
      parseOpenAIChatCompletionsStream,
    ),
    openaiResponses: (() => {
      const name = `${upstreamId}.openaiResponses`;
      const build = (facts: Readonly<ProviderPipelineOpenAIResponsesInput>): RequestFacts => {
        const modelKey = rawModelIdOf(facts);
        return facts['request.action'] === 'generate'
          ? requestBuilder({
              config,
              auth: 'bearer',
              path: customPathFor(config, '/responses'),
              body: { kind: 'json', value: { ...jsonBody(facts['request.payload'], modelKey), stream: true } },
              modelKey,
            })(facts)
          : requestBuilder({
              config,
              auth: 'bearer',
              path: appendPathSegment(customPathFor(config, '/responses'), '/compact'),
              body: { kind: 'json', value: { ...toCompactPayloadShape(facts['request.payload']), model: modelKey } },
              modelKey,
            })(facts);
      };
      return exchangePipeline<ProviderPipelineOpenAIResponsesInput, ProviderPipelineResponsesOutcome>(
        upstreamId,
        name,
        build,
        async (http, facts, env) => {
          if (facts['request.action'] === 'generate') {
            return {
              action: 'generate',
              ...await parseUpstreamSseOutcome(http, parseOpenAIResponsesStream, env),
            };
          }
          const modelKey = rawModelIdOf(facts);
          if (http.status < 200 || http.status >= 300) {
            return { action: 'compact', ok: false, modelKey, http } satisfies { readonly action: 'compact' } & ProviderPipelineCompactionOutcome;
          }
          const bytes = await readManagedBytes(http.body);
          const result = JSON.parse(new TextDecoder().decode(bytes)) as OpenAIResponsesCompactionResultEx;
          return {
            action: 'compact',
            ok: true,
            result,
            modelKey,
            http: {
              status: http.status,
              statusText: http.statusText,
              headers: http.headers,
              timing: http.timing,
            },
          } satisfies { readonly action: 'compact' } & ProviderPipelineCompactionOutcome;
        },
      );
    })(),
    anthropicMessages: ssePipeline<ProviderPipelineAnthropicMessagesInput, AnthropicMessagesStreamEventEx>(
      upstreamId,
      `${upstreamId}.anthropicMessages`,
      facts => requestBuilder<ProviderPipelineAnthropicMessagesInput>({
        config,
        auth: 'x-api-key',
        path: customPathFor(config, '/messages'),
        body: { kind: 'json', value: { ...jsonBody(facts['request.payload'], rawModelIdOf(facts)), stream: true } },
        modelKey: rawModelIdOf(facts),
        headers: (current, resolved) => anthropicTypedHeaders(resolved, current['request.anthropicBeta']),
      })(facts),
      parseAnthropicMessagesStream,
    ),
    anthropicMessagesCountTokens: httpPipeline<ProviderPipelineAnthropicMessagesCountTokensInput>(
      upstreamId,
      `${upstreamId}.anthropicMessagesCountTokens`,
      facts => requestBuilder<ProviderPipelineAnthropicMessagesCountTokensInput>({
        config,
        auth: 'x-api-key',
        path: appendPathSegment(customPathFor(config, '/messages'), '/count_tokens'),
        body: { kind: 'json', value: jsonBody(facts['request.payload'], rawModelIdOf(facts)) },
        modelKey: rawModelIdOf(facts),
        headers: (current, resolved) => anthropicTypedHeaders(resolved, current['request.anthropicBeta']),
      })(facts),
    ),
    geminiGenerateContent: ssePipeline<ProviderPipelineGeminiGenerateContentInput, GeminiGenerateContentStreamEvent>(
      upstreamId,
      `${upstreamId}.geminiGenerateContent`,
      facts => {
        const modelId = rawModelIdOf(facts).replace(/^models\//, '');
        return requestBuilder({
          config,
          auth: 'x-goog-api-key',
          path: appendPathSegment(
            customPathFor(config, '/v1beta/models'),
            `/${encodeURIComponent(modelId)}:streamGenerateContent`,
          ),
          extraQuery: [['alt', 'sse']],
          body: { kind: 'json', value: facts['request.payload'] },
          modelKey: modelId,
        })(facts);
      },
      parseGeminiGenerateContentStream,
    ),
    geminiGenerateContentCountTokens: httpPipeline<ProviderPipelineGeminiGenerateContentCountTokensInput>(
      upstreamId,
      `${upstreamId}.geminiGenerateContentCountTokens`,
      facts => {
        const modelId = rawModelIdOf(facts).replace(/^models\//, '');
        const request: GeminiCountTokensPayload = { generateContentRequest: { ...facts['request.payload'], model: `models/${modelId}` } };
        return requestBuilder({
          config,
          auth: 'x-goog-api-key',
          path: appendPathSegment(
            customPathFor(config, '/v1beta/models'),
            `/${encodeURIComponent(modelId)}:countTokens`,
          ),
          body: { kind: 'json', value: request },
          modelKey: modelId,
        })(facts);
      },
    ),
    openaiEmbeddings: httpPipeline<ProviderPipelineOpenAIEmbeddingsInput>(
      upstreamId,
      `${upstreamId}.openaiEmbeddings`,
      facts => requestBuilder({
        config,
        auth: 'bearer',
        path: customPathFor(config, '/embeddings'),
        body: { kind: 'json', value: jsonBody(facts['request.payload'], rawModelIdOf(facts)) },
        modelKey: rawModelIdOf(facts),
      })(facts),
    ),
    openaiImagesGenerations: httpPipeline<ProviderPipelineOpenAIImagesGenerationsInput>(
      upstreamId,
      `${upstreamId}.openaiImagesGenerations`,
      facts => requestBuilder({
        config,
        auth: 'bearer',
        path: customPathFor(config, '/images/generations'),
        body: { kind: 'json', value: jsonBody(facts['request.payload'], rawModelIdOf(facts)) },
        modelKey: rawModelIdOf(facts),
      })(facts),
    ),
    openaiImagesEdits: httpPipeline<ProviderPipelineOpenAIImagesEditsInput>(
      upstreamId,
      `${upstreamId}.openaiImagesEdits`,
      facts => requestBuilder({
        config,
        auth: 'bearer',
        path: customPathFor(config, '/images/edits'),
        body: buildImagesEditsHttpBody(facts['request.payload'], rawModelIdOf(facts)),
        modelKey: rawModelIdOf(facts),
      })(facts),
    ),
    openaiAudioTranscriptions: httpPipeline<ProviderPipelineOpenAIAudioTranscriptionsInput>(
      upstreamId,
      `${upstreamId}.openaiAudioTranscriptions`,
      facts => requestBuilder({
        config,
        auth: 'bearer',
        path: customPathFor(config, '/audio/transcriptions'),
        body: buildAudioTranscriptionMultipartBody(facts['request.payload'], { type: 'replace', value: rawModelIdOf(facts) }),
        modelKey: rawModelIdOf(facts),
      })(facts),
    ),
    rerank: (() => {
      const name = `${upstreamId}.rerank`;
      const build = (facts: Readonly<ProviderPipelineRerankInput>): RequestFacts => {
        const target = facts['provider.model'].rerankTarget;
        if (target === undefined) throw new Error(`Rerank model ${facts['provider.model'].id} has no outbound target`);
        const modelKey = rawModelIdOf(facts);
        return requestBuilder({
          config,
          auth: 'bearer',
          path: target.path ?? DEFAULT_RERANK_PATHS[target.protocol],
          body: { kind: 'json', value: serializeRerankRequest(target.protocol, modelKey, facts['request.payload']) },
          modelKey,
        })(facts);
      };
      return exchangePipeline<ProviderPipelineRerankInput, ProviderPipelineRerankOutcome>(
        upstreamId,
        name,
        build,
        async (http, facts) => {
          const target = facts['provider.model'].rerankTarget;
          if (target === undefined) throw new Error(`Rerank model ${facts['provider.model'].id} has no outbound target`);
          return { target, modelKey: rawModelIdOf(facts), http };
        },
      );
    })(),
    decision: (() => {
      const name = `${upstreamId}.decision`;
      const build = (facts: Readonly<ProviderPipelineDecisionInput>): RequestFacts => {
        const target = facts['provider.model'].decisionTarget;
        if (target === undefined) throw new Error(`Decision model ${facts['provider.model'].id} has no outbound target`);
        const modelKey = rawModelIdOf(facts);
        return requestBuilder({
          config,
          auth: 'bearer',
          path: target.path ?? DEFAULT_DECISION_PATHS[target.protocol],
          body: { kind: 'json', value: serializeDecisionRequest(target.protocol, modelKey, facts['request.payload']) },
          modelKey,
        })(facts);
      };
      return exchangePipeline<ProviderPipelineDecisionInput, ProviderPipelineDecisionOutcome>(
        upstreamId,
        name,
        build,
        async (http, facts) => {
          const target = facts['provider.model'].decisionTarget;
          if (target === undefined) throw new Error(`Decision model ${facts['provider.model'].id} has no outbound target`);
          return { target, modelKey: rawModelIdOf(facts), http };
        },
      );
    })(),
  };
};
