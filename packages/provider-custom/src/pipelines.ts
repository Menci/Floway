import type { CustomAuthStyle, CustomPathOverrideKey } from './config.ts';
import { customRequestHeaders } from './request-headers.ts';
import { geminiErrorBody, requireJsonResponseStage } from './response.ts';
import type { CustomUpstreamConfigFacts, CustomUpstreamFacts } from './upstream.ts';
import { compose } from '@floway-dev/pipeline';
import { parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest, type CanonicalDecisionRequest } from '@floway-dev/protocols/decision';
import { parseGeminiGenerateContentStream, type GeminiCountTokensPayload, type GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { parseOpenAIChatCompletionsStream, type OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAICompletionsPayload } from '@floway-dev/protocols/openai-completions';
import type { OpenAIEmbeddingsPayload } from '@floway-dev/protocols/openai-embeddings';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import { toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';
import { DEFAULT_RERANK_PATHS, serializeRerankRequest, type CanonicalRerankRequest } from '@floway-dev/protocols/rerank';
import {
  httpTerminal,
  httpUrl,
  joinBaseAndPath,
  parseHttpOutcomeStage,
  parseResponsesStage,
  parseSseStage,
  rewriteHttpRequestStage,
  serializeModelFieldOpenAIAudioTranscriptionRequest,
  serializeOpenAIImagesEditsRequest,
  type OpenAIAudioTranscriptionRequest,
  type OpenAIImagesEditsRequest,
  type ProviderAlphaSearchOutput,
  type ProviderAnthropicCountTokensOutput,
  type ProviderAnthropicInput,
  type ProviderAnthropicMessagesOutput,
  type ProviderDecisionOutput,
  type ProviderGeminiCountTokensOutput,
  type ProviderGeminiGenerateContentOutput,
  type ProviderHttpRequestUpdate,
  type ProviderInput,
  type ProviderModelFacts,
  type ProviderOpenAIAudioTranscriptionsOutput,
  type ProviderOpenAIChatCompletionsOutput,
  type ProviderOpenAICompletionsOutput,
  type ProviderOpenAIEmbeddingsOutput,
  type ProviderOpenAIImagesEditsOutput,
  type ProviderOpenAIImagesGenerationsOutput,
  type ProviderOpenAIResponsesOutput,
  type ProviderPipelines,
  type ProviderRequestBody,
  type ProviderRerankOutput,
  type ProviderResponsesInput,
  type ProviderServices,
} from '@floway-dev/provider';

type CustomInput<Payload> = ProviderInput<CustomUpstreamFacts, Payload>;
type AnthropicInput = ProviderAnthropicInput<CustomUpstreamFacts>;
type ResponsesInput = ProviderResponsesInput<CustomUpstreamFacts>;

const requestKeys = ['provider.upstream', 'provider.model', 'request.http', 'request.payload'] as const;
const anthropicKeys = [...requestKeys, 'request.anthropicBeta'] as const;
const responsesKeys = [...requestKeys, 'request.action'] as const;
const baseExit = ['response.http', 'response.modelKey'] as const;

// Gemini uses the model collection root directly.
// https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
const pathFor = (config: CustomUpstreamConfigFacts, key: CustomPathOverrideKey): string =>
  config.pathOverrides?.[key] ?? (key === '/v1beta/models' ? key : `/v1${key}`);

const requestFor = (
  config: CustomUpstreamConfigFacts,
  auth: CustomAuthStyle,
  endpoint: string,
  body: ProviderRequestBody,
  anthropicBeta?: readonly string[],
): ProviderHttpRequestUpdate => ({
  method: 'POST',
  url: httpUrl(joinBaseAndPath(config.baseUrl, endpoint), auth === 'x-goog-api-key' ? ['key'] : []),
  headers: customRequestHeaders(config, auth, anthropicBeta),
  body,
});

const jsonRequest = (endpoint: CustomPathOverrideKey, stream = false) =>
  rewriteHttpRequestStage<CustomInput<object>>('buildRequest', requestKeys, facts => {
    const { config } = facts['provider.upstream'];
    const modelKey = facts['provider.model'].upstreamModelId;
    const value = { ...facts['request.payload'], ...(stream ? { stream: true } : {}), model: modelKey };
    return { modelKey, request: requestFor(config, 'bearer', pathFor(config, endpoint), { kind: 'json', value }) };
  });

const multipartRequest = <Payload>(endpoint: CustomPathOverrideKey, serialize: (payload: Payload, modelKey: string) => ProviderRequestBody) =>
  rewriteHttpRequestStage<CustomInput<Payload>>('buildRequest', requestKeys, facts => {
    const { config } = facts['provider.upstream'];
    const modelKey = facts['provider.model'].upstreamModelId;
    const body = serialize(facts['request.payload'], modelKey);
    return { modelKey, request: requestFor(config, 'bearer', pathFor(config, endpoint), body) };
  });

const anthropicRequest = (stream: boolean) => rewriteHttpRequestStage<AnthropicInput>('buildRequest', anthropicKeys, facts => {
  const { config } = facts['provider.upstream'];
  const modelKey = facts['provider.model'].upstreamModelId;
  const value = { ...facts['request.payload'], ...(stream ? { stream: true } : {}), model: modelKey };
  const path = pathFor(config, '/messages');
  const endpoint = stream ? path : `${path}/count_tokens`;
  return { modelKey, request: requestFor(config, 'x-api-key', endpoint, { kind: 'json', value }, facts['request.anthropicBeta']) };
});

const responsesRequest = rewriteHttpRequestStage<ResponsesInput>('buildRequest', responsesKeys, facts => {
  const { config } = facts['provider.upstream'];
  const payload = facts['request.payload'];
  const modelKey = facts['provider.model'].upstreamModelId;
  const compact = facts['request.action'] === 'compact';
  const path = pathFor(config, '/responses');
  const endpoint = compact ? `${path}/compact` : path;
  const value = compact ? { ...toCompactPayloadShape(payload), model: modelKey } : { ...payload, stream: true, model: modelKey };
  return { modelKey, request: requestFor(config, 'bearer', endpoint, { kind: 'json', value }) };
});

const geminiRequest = (stream: boolean) => rewriteHttpRequestStage<CustomInput<GeminiGenerateContentPayload>>('buildRequest', requestKeys, facts => {
  const { config } = facts['provider.upstream'];
  const modelKey = facts['provider.model'].upstreamModelId.replace(/^models\//, '');
  const modelPath = `${pathFor(config, '/v1beta/models')}/${encodeURIComponent(modelKey)}`;
  const payload = facts['request.payload'];
  // Count generation fields through the envelope, which requires the full model name.
  // https://ai.google.dev/api/tokens#method:-models.counttokens
  const count: GeminiCountTokensPayload = { generateContentRequest: { ...payload, model: `models/${modelKey}` } };
  const endpoint = stream ? `${modelPath}:streamGenerateContent?alt=sse` : `${modelPath}:countTokens`;
  return { modelKey, request: requestFor(config, 'x-goog-api-key', endpoint, { kind: 'json', value: stream ? payload : count }) };
});

const requireTarget = <Target>(kind: string, model: ProviderModelFacts, target: Target | undefined): Target => {
  if (target === undefined) throw new Error(`${kind} model ${model.id} has no outbound target`);
  return target;
};

const rerankTarget = (model: ProviderModelFacts) => requireTarget('Rerank', model, model.rerankTarget);
const decisionTarget = (model: ProviderModelFacts) => requireTarget('Decision', model, model.decisionTarget);

const targetedRequest = <Payload, Protocol extends string, Target extends { protocol: Protocol; path?: string }>(
  targetOf: (model: ProviderModelFacts) => Target,
  paths: Readonly<Record<Protocol, string>>,
  serialize: (protocol: Protocol, modelKey: string, payload: Payload) => object,
) => rewriteHttpRequestStage<CustomInput<Payload>>('buildRequest', requestKeys, facts => {
  const { config } = facts['provider.upstream'];
  const model = facts['provider.model'];
  const target = targetOf(model);
  const modelKey = model.upstreamModelId;
  const endpoint = target.path ?? paths[target.protocol];
  const value = serialize(target.protocol, modelKey, facts['request.payload']);
  return { modelKey, request: requestFor(config, 'bearer', endpoint, { kind: 'json', value }) };
});

export const customPipelines = {
  alphaSearch: compose<CustomInput<Record<string, unknown>> & ProviderAlphaSearchOutput, ProviderServices>()('custom.alphaSearch', {
    entry: requestKeys,
    exit: [...baseExit, 'response.alphaSearch'],
    stages: [parseHttpOutcomeStage('parseHttp', 'response.alphaSearch'), jsonRequest('/alpha/search')],
    ending: httpTerminal,
  }),
  openaiCompletions: compose<CustomInput<Omit<OpenAICompletionsPayload, 'model'>> & ProviderOpenAICompletionsOutput, ProviderServices>()('custom.openaiCompletions', {
    entry: requestKeys,
    exit: [...baseExit, 'response.openaiCompletions'],
    stages: [parseHttpOutcomeStage('parseHttp', 'response.openaiCompletions'), jsonRequest('/completions')],
    ending: httpTerminal,
  }),
  openaiChatCompletions: compose<CustomInput<Omit<OpenAIChatCompletionsPayloadEx, 'model'>> & ProviderOpenAIChatCompletionsOutput, ProviderServices>()('custom.openaiChatCompletions', {
    entry: requestKeys,
    exit: [...baseExit, 'response.openaiChatCompletions'],
    stages: [parseSseStage('parseSse', 'response.openaiChatCompletions', parseOpenAIChatCompletionsStream), jsonRequest('/chat/completions', true)],
    ending: httpTerminal,
  }),
  openaiResponses: compose<ResponsesInput & ProviderOpenAIResponsesOutput, ProviderServices>()('custom.openaiResponses', {
    entry: responsesKeys,
    exit: [...baseExit, 'response.openaiResponses'],
    stages: [parseResponsesStage<CustomUpstreamFacts>(), responsesRequest],
    ending: httpTerminal,
  }),
  anthropicMessages: compose<AnthropicInput & ProviderAnthropicMessagesOutput, ProviderServices>()('custom.anthropicMessages', {
    entry: anthropicKeys,
    exit: [...baseExit, 'response.anthropicMessages'],
    stages: [parseSseStage('parseSse', 'response.anthropicMessages', parseAnthropicMessagesStream), anthropicRequest(true)],
    ending: httpTerminal,
  }),
  anthropicMessagesCountTokens: compose<AnthropicInput & ProviderAnthropicCountTokensOutput, ProviderServices>()('custom.anthropicMessagesCountTokens', {
    entry: anthropicKeys,
    exit: [...baseExit, 'response.anthropicMessagesCountTokens'],
    stages: [parseHttpOutcomeStage('parseHttp', 'response.anthropicMessagesCountTokens'), anthropicRequest(false)],
    ending: httpTerminal,
  }),
  geminiGenerateContent: compose<CustomInput<GeminiGenerateContentPayload> & ProviderGeminiGenerateContentOutput, ProviderServices>()('custom.geminiGenerateContent', {
    entry: requestKeys,
    exit: [...baseExit, 'response.geminiGenerateContent'],
    stages: [parseSseStage('parseSse', 'response.geminiGenerateContent', parseGeminiGenerateContentStream, { formatNonJsonError: geminiErrorBody }), geminiRequest(true)],
    ending: httpTerminal,
  }),
  geminiGenerateContentCountTokens: compose<CustomInput<GeminiGenerateContentPayload> & ProviderGeminiCountTokensOutput, ProviderServices>()('custom.geminiGenerateContentCountTokens', {
    entry: requestKeys,
    exit: [...baseExit, 'response.geminiGenerateContentCountTokens'],
    stages: [
      parseHttpOutcomeStage('parseHttp', 'response.geminiGenerateContentCountTokens', { formatNonJsonError: geminiErrorBody }),
      requireJsonResponseStage('Gemini countTokens', message => geminiErrorBody(502, message)),
      geminiRequest(false),
    ],
    ending: httpTerminal,
  }),
  openaiEmbeddings: compose<CustomInput<Omit<OpenAIEmbeddingsPayload, 'model'>> & ProviderOpenAIEmbeddingsOutput, ProviderServices>()('custom.openaiEmbeddings', {
    entry: requestKeys,
    exit: [...baseExit, 'response.openaiEmbeddings'],
    stages: [parseHttpOutcomeStage('parseHttp', 'response.openaiEmbeddings'), jsonRequest('/embeddings')],
    ending: httpTerminal,
  }),
  openaiImagesGenerations: compose<CustomInput<Omit<OpenAIImagesGenerationsPayload, 'model'>> & ProviderOpenAIImagesGenerationsOutput, ProviderServices>()('custom.openaiImagesGenerations', {
    entry: requestKeys,
    exit: [...baseExit, 'response.openaiImagesGenerations'],
    stages: [parseHttpOutcomeStage('parseHttp', 'response.openaiImagesGenerations'), jsonRequest('/images/generations')],
    ending: httpTerminal,
  }),
  openaiImagesEdits: compose<CustomInput<OpenAIImagesEditsRequest> & ProviderOpenAIImagesEditsOutput, ProviderServices>()('custom.openaiImagesEdits', {
    entry: requestKeys,
    exit: [...baseExit, 'response.openaiImagesEdits'],
    stages: [parseHttpOutcomeStage('parseHttp', 'response.openaiImagesEdits'), multipartRequest('/images/edits', serializeOpenAIImagesEditsRequest)],
    ending: httpTerminal,
  }),
  openaiAudioTranscriptions: compose<CustomInput<OpenAIAudioTranscriptionRequest> & ProviderOpenAIAudioTranscriptionsOutput, ProviderServices>()('custom.openaiAudioTranscriptions', {
    entry: requestKeys,
    exit: [...baseExit, 'response.openaiAudioTranscriptions'],
    stages: [parseHttpOutcomeStage('parseHttp', 'response.openaiAudioTranscriptions'), multipartRequest('/audio/transcriptions', serializeModelFieldOpenAIAudioTranscriptionRequest)],
    ending: httpTerminal,
  }),
  rerank: compose<CustomInput<CanonicalRerankRequest> & ProviderRerankOutput, ProviderServices>()('custom.rerank', {
    entry: requestKeys,
    exit: [...baseExit, 'response.rerank'],
    stages: [
      parseHttpOutcomeStage('parseHttp', 'response.rerank', {
        needs: ['provider.model'],
        extra: (facts: Pick<CustomInput<CanonicalRerankRequest>, 'provider.model'>) => ({ target: rerankTarget(facts['provider.model']) }),
      }),
      requireJsonResponseStage('rerank'),
      targetedRequest(rerankTarget, DEFAULT_RERANK_PATHS, serializeRerankRequest),
    ],
    ending: httpTerminal,
  }),
  decision: compose<CustomInput<CanonicalDecisionRequest> & ProviderDecisionOutput, ProviderServices>()('custom.decision', {
    entry: requestKeys,
    exit: [...baseExit, 'response.decision'],
    stages: [
      parseHttpOutcomeStage('parseHttp', 'response.decision', {
        needs: ['provider.model'],
        extra: (facts: Pick<CustomInput<CanonicalDecisionRequest>, 'provider.model'>) => ({ target: decisionTarget(facts['provider.model']) }),
      }),
      requireJsonResponseStage('decision'),
      targetedRequest(decisionTarget, DEFAULT_DECISION_PATHS, serializeDecisionRequest),
    ],
    ending: httpTerminal,
  }),
} satisfies Required<ProviderPipelines<CustomUpstreamFacts>>;
