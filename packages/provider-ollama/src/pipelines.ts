import { isOllamaAccountProbeDue, refreshOllamaAccount } from './account-probe.ts';
import type { OllamaUpstreamConfig } from './config.ts';
import type { OllamaUpstreamState } from './state.ts';
import { isOllamaUsageEnabled, isOllamaUsageProbeDue, refreshOllamaUsageProbe } from './usage-probe.ts';
import { compose, defineStage, secret, snapshotError, transform, type Deferred, type ErrorSnapshot, type Stage, type StageEnv } from '@floway-dev/pipeline';
import { parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import type { DecisionTarget } from '@floway-dev/protocols/common';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest, type CanonicalDecisionRequest } from '@floway-dev/protocols/decision';
import { parseOpenAIChatCompletionsStream, type OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream, toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';
import {
  buildHttpRequestStage,
  encodeHttpRequest,
  headersForAnthropicMessagesCall,
  httpTerminal,
  httpUrl,
  joinBaseAndPath,
  parseCompactionStage,
  parseSseStage,
  serializeModelFieldOpenAIAudioTranscriptionRequest,
  type HeaderEntry,
  type HttpRequestFacts,
  type HttpResponseFacts,
  type OpenAIAudioTranscriptionRequest,
  type ProviderAnthropicInput,
  type ProviderHttpOutput,
  type ProviderHttpRequest,
  type ProviderInput,
  type ProviderPipelines,
  type ProviderRequestBody,
  type ProviderResponsesInput,
  type ProviderServices,
  type ProviderTargetOutput,
} from '@floway-dev/provider';

const requestKeys: readonly (keyof ProviderInput<unknown>)[] = ['provider.model', 'request.headers', 'request.payload'];
const anthropicKeys: readonly (keyof ProviderAnthropicInput)[] = [...requestKeys, 'request.anthropicBeta'];
const responseKeys: readonly (keyof ProviderResponsesInput)[] = [...requestKeys, 'request.action'];

type ChatInput = ProviderInput<Omit<OpenAIChatCompletionsPayloadEx, 'model'>>;

// The Ollama shim maps max_tokens onto num_predict and omits the modern spelling.
// https://github.com/ollama/ollama/blob/9a4b136efefecb51b428d22e79b0f3d15769a1f8/openai/openai.go#L110-L125
// https://github.com/ollama/ollama/blob/9a4b136efefecb51b428d22e79b0f3d15769a1f8/openai/openai.go#L753-L755
const renameOutputCap = defineStage<ChatInput, ChatInput, {}, {}>({
  name: 'renameOutputCap',
  through: {
    request: { needs: ['request.payload'], consumes: ['request.payload'], provides: ['request.payload'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const payload = facts['request.payload'];
      if (payload.max_completion_tokens === undefined || payload.max_tokens !== undefined) return facts;
      const { max_completion_tokens, ...rest } = payload;
      return { ...facts, 'request.payload': { ...rest, max_tokens: max_completion_tokens } };
    },
  })),
});

type ProbeResult = { readonly persisted: true } | { readonly persisted: false; readonly error: ErrorSnapshot };

type ProbeOutput = ProviderHttpOutput & {
  readonly 'response.provider.usageProbe': Deferred<ProbeResult> | undefined;
  readonly 'response.provider.accountProbe': Deferred<ProbeResult> | undefined;
};

const deferProbe = (
  name: 'usage' | 'account', upstreamId: string, work: Promise<unknown>, env: StageEnv<ProviderServices>,
): Deferred<ProbeResult> => env.defer(`ollama.${name}Probe`, work.then<ProbeResult, ProbeResult>(
  () => ({ persisted: true }),
  (error: unknown) => {
    const warning = `Failed to refresh Ollama ${name} for ${upstreamId}:`;
    console.warn(warning, error);
    const snapshot = snapshotError(error);
    env.log.warn(warning, { error: snapshot });
    return { persisted: false, error: snapshot };
  },
));

const probeAfterResponse = (upstreamId: string, config: OllamaUpstreamConfig, state: OllamaUpstreamState) => defineStage<
  {}, {}, ProviderHttpOutput, ProbeOutput, ProviderServices
>({
  name: 'probeAfterResponse',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: { needs: ['response.http'], consumes: [], provides: ['response.provider.usageProbe', 'response.provider.accountProbe'] },
  },
  async execute(facts, next, env) {
    const back = await next(facts);
    const enabled = isOllamaUsageEnabled(config);
    const now = Date.now();
    const usage = enabled && isOllamaUsageProbeDue(state, now)
      ? deferProbe('usage', upstreamId, refreshOllamaUsageProbe(upstreamId, config, env.services.fetcher(upstreamId)), env)
      : undefined;
    const account = enabled && isOllamaAccountProbeDue(state, now)
      ? deferProbe('account', upstreamId, refreshOllamaAccount(upstreamId, config, env.services.fetcher(upstreamId)), env)
      : undefined;
    return { ...back, 'response.provider.usageProbe': usage, 'response.provider.accountProbe': account };
  },
});

export const createOllamaPipelines = (upstreamId: string, config: OllamaUpstreamConfig, state: OllamaUpstreamState): ProviderPipelines => {
  const ending = httpTerminal(upstreamId);
  const assemble = <In, Out>(operation: string, ...stages: Stage<ProviderServices>[]) =>
    compose<In, Out, ProviderServices>(`${upstreamId}.${operation}`, { stages, ending });
  const probe = probeAfterResponse(upstreamId, config, state);
  const authorization = config.apiKey === undefined ? undefined : secret(`Bearer ${config.apiKey}`);
  const request = (path: string, body: ProviderRequestBody, extra: readonly HeaderEntry[]): ProviderHttpRequest => {
    const headers = new Map<string, HeaderEntry[1]>();
    if (authorization !== undefined) headers.set('authorization', authorization);
    for (const [name, value] of extra) headers.set(name.toLowerCase(), value);
    return { method: 'POST', url: httpUrl(joinBaseAndPath(config.baseUrl, path)), headers: [...headers], body };
  };
  const json = (path: string, stream = false) => buildHttpRequestStage<ProviderInput<object>>('buildRequest', requestKeys, facts => {
    const modelKey = facts['provider.model'].upstreamModelId;
    const value = { ...facts['request.payload'], ...(stream ? { stream: true } : {}), model: modelKey };
    return { modelKey, request: request(path, { kind: 'json', value }, facts['request.headers']) };
  });
  const anthropic = (stream: boolean) => buildHttpRequestStage<ProviderAnthropicInput>('buildRequest', anthropicKeys, facts => {
    const modelKey = facts['provider.model'].upstreamModelId;
    const value = { ...facts['request.payload'], ...(stream ? { stream: true } : {}), model: modelKey };
    const path = stream ? '/v1/messages' : '/v1/messages/count_tokens';
    const headers = headersForAnthropicMessagesCall(facts['request.headers'], facts['request.anthropicBeta']);
    return { modelKey, request: request(path, { kind: 'json', value }, headers) };
  });

  // Cloud inference refreshes balances even after a rate limit. Count tokens
  // and the decision endpoint do not trigger account or usage refreshes.
  return {
    openaiCompletions: assemble('openaiCompletions', probe, json('/v1/completions')),
    openaiChatCompletions: assemble('openaiChatCompletions', renameOutputCap, probe, parseSseStage('parseSse', parseOpenAIChatCompletionsStream), json('/v1/chat/completions', true)),
    openaiResponses: assemble(
      'openaiResponses',
      // Initiate probes after SSE validation for generation or before reading compact JSON.
      parseCompactionStage(),
      probe,
      parseSseStage('parseSse', parseOpenAIResponsesStream, {
        needs: ['request.action'],
        when: (facts: ProviderResponsesInput) => facts['request.action'] === 'generate',
      }),
      buildHttpRequestStage<ProviderResponsesInput>('buildRequest', responseKeys, facts => {
        const payload = facts['request.payload'];
        const modelKey = facts['provider.model'].upstreamModelId;
        const compact = facts['request.action'] === 'compact';
        const path = compact ? '/v1/responses/compact' : '/v1/responses';
        const value = compact ? { ...toCompactPayloadShape(payload), model: modelKey } : { ...payload, stream: true, model: modelKey };
        return { modelKey, request: request(path, { kind: 'json', value }, facts['request.headers']) };
      }),
    ),
    anthropicMessages: assemble('anthropicMessages', probe, parseSseStage('parseSse', parseAnthropicMessagesStream), anthropic(true)),
    anthropicMessagesCountTokens: assemble('anthropicMessagesCountTokens', anthropic(false)),
    openaiEmbeddings: assemble('openaiEmbeddings', probe, json('/v1/embeddings')),
    openaiAudioTranscriptions: assemble('openaiAudioTranscriptions', probe, buildHttpRequestStage<ProviderInput<OpenAIAudioTranscriptionRequest>>('buildRequest', requestKeys, facts => {
      const modelKey = facts['provider.model'].upstreamModelId;
      const body = serializeModelFieldOpenAIAudioTranscriptionRequest(facts['request.payload'], modelKey);
      // The compatibility route adapts the multipart audio upload to native chat.
      // https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/server/routes.go#L1916-L1922
      // https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/middleware/openai.go#L682-L789
      return { modelKey, request: request('/v1/audio/transcriptions', body, facts['request.headers']) };
    })),
    decision: assemble('decision', defineStage<
      ProviderInput<CanonicalDecisionRequest>,
      { 'request.http': HttpRequestFacts },
      { 'response.http': HttpResponseFacts },
      ProviderTargetOutput<DecisionTarget>,
      ProviderServices
    >({
      name: 'buildRequest',
      through: {
        request: { needs: requestKeys, consumes: [], provides: ['request.http'] },
        response: { needs: ['response.http'], consumes: [], provides: ['response.modelKey', 'response.target'] },
      },
      async execute(facts, next) {
        const model = facts['provider.model'];
        const target = model.decisionTarget;
        if (target === undefined) throw new Error(`Decision model ${model.id} has no outbound target`);
        const modelKey = model.upstreamModelId;
        const path = target.path ?? DEFAULT_DECISION_PATHS[target.protocol];
        const body: ProviderRequestBody = { kind: 'json', value: serializeDecisionRequest(target.protocol, modelKey, facts['request.payload']) };
        const outgoing = request(path, body, facts['request.headers']);
        const back = await next({ ...facts, 'request.http': encodeHttpRequest(outgoing) });
        return { ...back, 'response.modelKey': modelKey, 'response.target': target };
      },
    })),
  };
};
