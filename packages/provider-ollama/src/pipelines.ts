import type { OllamaUpstreamFacts } from './config.ts';
import type { OllamaServices } from './service.ts';
import { compose, defineStage, secret, transform } from '@floway-dev/pipeline';
import { parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest, type CanonicalDecisionRequest } from '@floway-dev/protocols/decision';
import { parseOpenAIChatCompletionsStream, type OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAICompletionsPayload } from '@floway-dev/protocols/openai-completions';
import type { OpenAIEmbeddingsPayload } from '@floway-dev/protocols/openai-embeddings';
import { toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';
import {
  deleteHeader,
  headersForAnthropicMessagesCall,
  httpTerminal,
  httpUrl,
  joinBaseAndPath,
  parseHttpOutcomeStage,
  parseResponsesStage,
  parseSseStage,
  rewriteHttpRequestStage,
  serializeModelFieldOpenAIAudioTranscriptionRequest,
  setHeader,
  stripHttpHeaders,
  type HttpResponseFacts,
  type OpenAIAudioTranscriptionRequest,
  type ProviderAnthropicCountTokensOutput,
  type ProviderAnthropicInput,
  type ProviderAnthropicMessagesOutput,
  type ProviderDecisionOutput,
  type ProviderHttpRequestUpdate,
  type ProviderInput,
  type ProviderModelFacts,
  type ProviderOpenAIAudioTranscriptionsOutput,
  type ProviderOpenAIChatCompletionsOutput,
  type ProviderOpenAICompletionsOutput,
  type ProviderOpenAIEmbeddingsOutput,
  type ProviderOpenAIResponsesOutput,
  type ProviderPipelines,
  type ProviderRequestBody,
  type ProviderResponsesInput,
} from '@floway-dev/provider';

type OllamaInput<Payload> = ProviderInput<OllamaUpstreamFacts, Payload>;
type ChatInput = OllamaInput<Omit<OpenAIChatCompletionsPayloadEx, 'model'>>;
type CompletionsInput = OllamaInput<Omit<OpenAICompletionsPayload, 'model'>>;
type EmbeddingsInput = OllamaInput<Omit<OpenAIEmbeddingsPayload, 'model'>>;
type AudioInput = OllamaInput<OpenAIAudioTranscriptionRequest>;
type DecisionInput = OllamaInput<CanonicalDecisionRequest>;
type AnthropicInput = ProviderAnthropicInput<OllamaUpstreamFacts>;
type ResponsesInput = ProviderResponsesInput<OllamaUpstreamFacts>;

const requestKeys = ['provider.upstream', 'provider.model', 'request.http', 'request.payload'] as const;
const anthropicKeys = [...requestKeys, 'request.anthropicBeta'] as const;
const responsesKeys = [...requestKeys, 'request.action'] as const;
const outputKeys = ['response.http', 'response.modelKey'] as const;

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

type ProbeInput = Pick<OllamaInput<unknown>, 'provider.upstream'>;
type ProbeOutput = { readonly 'response.http': HttpResponseFacts };

const probeAfterResponse = <Input extends ProbeInput>(
  name: string,
  needs: readonly (keyof Input & string)[],
  shouldProbe: (facts: Input) => boolean,
) => defineStage<Input, Input, ProbeOutput, ProbeOutput, OllamaServices>({
  name,
  through: {
    request: { needs: ['provider.upstream', ...needs], consumes: [], provides: [] },
    response: { needs: ['response.http'], consumes: [], provides: [] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    if (back['response.http'].transportError !== undefined || !shouldProbe(facts)) return back;
    const upstream = facts['provider.upstream'];
    const probes = await scope.services.ollama.probeAfterResponse(upstream, scope.services.fetcher(upstream.id));
    for (const [kind, work] of Object.entries(probes)) {
      scope.defer(`ollama.${kind}Probe`, work.then(result => {
        if (!result.persisted) {
          const warning = `Failed to refresh Ollama ${kind} for ${upstream.id}:`;
          console.warn(warning, result.error);
          scope.log.warn(warning, { error: result.error });
        }
        return result;
      }));
    }
    return back;
  },
});

const probe = probeAfterResponse('probeAfterResponse', [], () => true);
const probeGeneration = probeAfterResponse<ResponsesInput>(
  'probeAfterGeneration', ['request.action'], facts => facts['request.action'] === 'generate',
);
const probeCompaction = probeAfterResponse<ResponsesInput>(
  'probeBeforeCompactionParse', ['request.action'], facts => facts['request.action'] === 'compact',
);

const keepOpenAIHeader = (name: string): boolean => name === 'authorization' || name === 'content-type';
const stripOpenAIHeaders = stripHttpHeaders(keepOpenAIHeader);
const stripAnthropicHeaders = stripHttpHeaders(name =>
  keepOpenAIHeader(name) || name === 'anthropic-version' || name === 'anthropic-beta');

const ollamaRequest = (
  { config }: OllamaUpstreamFacts,
  path: string,
  body: ProviderRequestBody,
  anthropicBeta?: readonly string[],
): ProviderHttpRequestUpdate => ({
  method: 'POST',
  url: httpUrl(joinBaseAndPath(config.baseUrl, path)),
  headers: headers => {
    const authorized = config.apiKey === undefined
      ? deleteHeader(headers, 'authorization')
      : setHeader(headers, 'authorization', secret(`Bearer ${config.apiKey.reveal()}`));
    return anthropicBeta === undefined ? authorized : headersForAnthropicMessagesCall(authorized, anthropicBeta);
  },
  body,
});

const buildJsonRequest = (path: string, stream = false) => rewriteHttpRequestStage<OllamaInput<object>>('buildRequest', requestKeys, facts => {
  const modelKey = facts['provider.model'].upstreamModelId;
  const value = { ...facts['request.payload'], ...(stream ? { stream: true } : {}), model: modelKey };
  return { modelKey, request: ollamaRequest(facts['provider.upstream'], path, { kind: 'json', value }) };
});

const buildAnthropicRequest = (stream: boolean) => rewriteHttpRequestStage<AnthropicInput>('buildRequest', anthropicKeys, facts => {
  const modelKey = facts['provider.model'].upstreamModelId;
  const value = { ...facts['request.payload'], ...(stream ? { stream: true } : {}), model: modelKey };
  const path = stream ? '/v1/messages' : '/v1/messages/count_tokens';
  return { modelKey, request: ollamaRequest(facts['provider.upstream'], path, { kind: 'json', value }, facts['request.anthropicBeta']) };
});

const buildResponsesRequest = rewriteHttpRequestStage<ResponsesInput>('buildRequest', responsesKeys, facts => {
  const payload = facts['request.payload'];
  const modelKey = facts['provider.model'].upstreamModelId;
  const compact = facts['request.action'] === 'compact';
  const path = compact ? '/v1/responses/compact' : '/v1/responses';
  const value = compact ? { ...toCompactPayloadShape(payload), model: modelKey } : { ...payload, stream: true, model: modelKey };
  return { modelKey, request: ollamaRequest(facts['provider.upstream'], path, { kind: 'json', value }) };
});

const buildAudioRequest = rewriteHttpRequestStage<AudioInput>('buildRequest', requestKeys, facts => {
  const modelKey = facts['provider.model'].upstreamModelId;
  const body = serializeModelFieldOpenAIAudioTranscriptionRequest(facts['request.payload'], modelKey);
  // The compatibility route adapts the multipart audio upload to native chat.
  // https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/server/routes.go#L1916-L1922
  // https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/middleware/openai.go#L682-L789
  return { modelKey, request: ollamaRequest(facts['provider.upstream'], '/v1/audio/transcriptions', body) };
});

const decisionTarget = (model: ProviderModelFacts) => {
  if (model.decisionTarget === undefined) throw new Error(`Decision model ${model.id} has no outbound target`);
  return model.decisionTarget;
};

const buildDecisionRequest = rewriteHttpRequestStage<DecisionInput>('buildRequest', requestKeys, facts => {
  const model = facts['provider.model'];
  const target = decisionTarget(model);
  const modelKey = model.upstreamModelId;
  const path = target.path ?? DEFAULT_DECISION_PATHS[target.protocol];
  const value = serializeDecisionRequest(target.protocol, modelKey, facts['request.payload']);
  return { modelKey, request: ollamaRequest(facts['provider.upstream'], path, { kind: 'json', value }) };
});

// A cloud inference response can refresh balances even after a rate limit.
export const ollamaPipelines = {
  openaiCompletions: compose<CompletionsInput & ProviderOpenAICompletionsOutput, OllamaServices>()('ollama.openaiCompletions', {
    entry: requestKeys,
    exit: [...outputKeys, 'response.openaiCompletions'],
    stages: [parseHttpOutcomeStage('parseOutcome', 'response.openaiCompletions'), probe, buildJsonRequest('/v1/completions'), stripOpenAIHeaders],
    ending: httpTerminal,
  }),
  openaiChatCompletions: compose<ChatInput & ProviderOpenAIChatCompletionsOutput, OllamaServices>()('ollama.openaiChatCompletions', {
    entry: requestKeys,
    exit: [...outputKeys, 'response.openaiChatCompletions'],
    stages: [
      renameOutputCap, probe, parseSseStage('parseSse', 'response.openaiChatCompletions', parseOpenAIChatCompletionsStream),
      buildJsonRequest('/v1/chat/completions', true), stripOpenAIHeaders,
    ],
    ending: httpTerminal,
  }),
  openaiResponses: compose<ResponsesInput & ProviderOpenAIResponsesOutput, OllamaServices>()('ollama.openaiResponses', {
    entry: responsesKeys,
    exit: [...outputKeys, 'response.openaiResponses'],
    // Generation validates SSE before probing. Compaction probes before reading JSON.
    stages: [probeGeneration, parseResponsesStage(), probeCompaction, buildResponsesRequest, stripOpenAIHeaders],
    ending: httpTerminal,
  }),
  anthropicMessages: compose<AnthropicInput & ProviderAnthropicMessagesOutput, OllamaServices>()('ollama.anthropicMessages', {
    entry: anthropicKeys,
    exit: [...outputKeys, 'response.anthropicMessages'],
    stages: [
      probe, parseSseStage('parseSse', 'response.anthropicMessages', parseAnthropicMessagesStream),
      buildAnthropicRequest(true), stripAnthropicHeaders,
    ],
    ending: httpTerminal,
  }),
  anthropicMessagesCountTokens: compose<AnthropicInput & ProviderAnthropicCountTokensOutput, OllamaServices>()('ollama.anthropicMessagesCountTokens', {
    entry: anthropicKeys,
    exit: [...outputKeys, 'response.anthropicMessagesCountTokens'],
    stages: [parseHttpOutcomeStage('parseOutcome', 'response.anthropicMessagesCountTokens'), buildAnthropicRequest(false), stripAnthropicHeaders],
    ending: httpTerminal,
  }),
  openaiEmbeddings: compose<EmbeddingsInput & ProviderOpenAIEmbeddingsOutput, OllamaServices>()('ollama.openaiEmbeddings', {
    entry: requestKeys,
    exit: [...outputKeys, 'response.openaiEmbeddings'],
    stages: [parseHttpOutcomeStage('parseOutcome', 'response.openaiEmbeddings'), probe, buildJsonRequest('/v1/embeddings'), stripOpenAIHeaders],
    ending: httpTerminal,
  }),
  openaiAudioTranscriptions: compose<AudioInput & ProviderOpenAIAudioTranscriptionsOutput, OllamaServices>()('ollama.openaiAudioTranscriptions', {
    entry: requestKeys,
    exit: [...outputKeys, 'response.openaiAudioTranscriptions'],
    stages: [parseHttpOutcomeStage('parseOutcome', 'response.openaiAudioTranscriptions'), probe, buildAudioRequest, stripOpenAIHeaders],
    ending: httpTerminal,
  }),
  decision: compose<DecisionInput & ProviderDecisionOutput, OllamaServices>()('ollama.decision', {
    entry: requestKeys,
    exit: [...outputKeys, 'response.decision'],
    stages: [
      parseHttpOutcomeStage('parseOutcome', 'response.decision', {
        needs: ['provider.model'],
        extra: (facts: Pick<DecisionInput, 'provider.model'>) => ({ target: decisionTarget(facts['provider.model']) }),
      }),
      buildDecisionRequest, stripOpenAIHeaders,
    ],
    ending: httpTerminal,
  }),
} satisfies ProviderPipelines<OllamaUpstreamFacts, OllamaServices>;
