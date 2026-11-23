import type { CustomAuthStyle, CustomPathOverrideKey, CustomUpstreamConfig } from './config.ts';
import { customAuthHeaders } from './fetch.ts';
import { compose, defineStage, secret, type Stage } from '@floway-dev/pipeline';
import { parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest, type CanonicalDecisionRequest } from '@floway-dev/protocols/decision';
import { parseGeminiGenerateContentStream, type GeminiCountTokensPayload, type GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import { parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream, toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';
import { DEFAULT_RERANK_PATHS, serializeRerankRequest, type CanonicalRerankRequest } from '@floway-dev/protocols/rerank';
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
  serializeOpenAIImagesEditsRequest,
  type HeaderEntry,
  type HttpRequestFacts,
  type HttpResponseFacts,
  type OpenAIAudioTranscriptionRequest,
  type OpenAIImagesEditsRequest,
  type ProviderAnthropicInput,
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

const resolveRules = (rules: CustomUpstreamConfig['ingressHeadersRules']) => {
  const valuesByKey = new Map<string, (string | null)[]>();
  for (const { key, value } of rules) {
    const values = valuesByKey.get(key);
    if (values) values.push(value);
    else valuesByKey.set(key, [value]);
  }

  return (admitted: readonly HeaderEntry[]): readonly HeaderEntry[] => {
    const resolved = admitted.filter(([name]) => !valuesByKey.has(name.toLowerCase()));
    for (const [key, values] of valuesByKey) {
      const incoming = admitted.filter(([name]) => name.toLowerCase() === key);
      for (const value of values) {
        if (value === null) resolved.push(...incoming);
        else resolved.push([key, value]);
      }
    }
    return resolved;
  };
};

export const createCustomPipelines = (upstreamId: string, config: CustomUpstreamConfig): ProviderPipelines => {
  const resolveHeaders = resolveRules(config.ingressHeadersRules);
  // Gemini uses the model collection root directly.
  // https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
  const path = (key: CustomPathOverrideKey): string =>
    config.pathOverrides?.[key] ?? (key === '/v1beta/models' ? key : `/v1${key}`);
  const request = (
    auth: CustomAuthStyle, endpoint: string, body: ProviderRequestBody, extra: readonly HeaderEntry[],
  ): ProviderHttpRequest => {
    const supplied = new Set(extra.map(([name]) => name.toLowerCase()));
    const defaults: HeaderEntry[] = [...customAuthHeaders(config.apiKey, auth)];
    if (body && 'kind' in body && body.kind === 'json') defaults.push(['Content-Type', 'application/json']);
    const headers: HeaderEntry[] = [...defaults.filter(([name]) => !supplied.has(name.toLowerCase())), ...extra];
    return {
      method: 'POST',
      url: httpUrl(joinBaseAndPath(config.baseUrl, endpoint)),
      headers: headers.map(([name, value]): HeaderEntry =>
        name.toLowerCase() === 'x-goog-api-key' && typeof value === 'string' ? [name, secret(value)] : [name, value]),
      body,
    };
  };

  const ending = httpTerminal(upstreamId);
  const assemble = <In, Out>(operation: string, ...stages: Stage<ProviderServices>[]) =>
    compose<In, Out, ProviderServices>(`${upstreamId}.${operation}`, { stages, ending });
  const json = (endpoint: CustomPathOverrideKey, stream = false) =>
    buildHttpRequestStage<ProviderInput<object>>('buildRequest', requestKeys, facts => {
      const modelKey = facts['provider.model'].upstreamModelId;
      const value = { ...facts['request.payload'], ...(stream ? { stream: true } : {}), model: modelKey };
      return { modelKey, request: request('bearer', path(endpoint), { kind: 'json', value }, resolveHeaders(facts['request.headers'])) };
    });
  const multipart = <Payload>(endpoint: CustomPathOverrideKey, serialize: (payload: Payload, modelKey: string) => ProviderRequestBody) =>
    buildHttpRequestStage<ProviderInput<Payload>>('buildRequest', requestKeys, facts => {
      const modelKey = facts['provider.model'].upstreamModelId;
      return { modelKey, request: request('bearer', path(endpoint), serialize(facts['request.payload'], modelKey), resolveHeaders(facts['request.headers'])) };
    });
  const anthropic = (stream: boolean) => buildHttpRequestStage<ProviderAnthropicInput>('buildRequest', anthropicKeys, facts => {
    const modelKey = facts['provider.model'].upstreamModelId;
    const value = { ...facts['request.payload'], ...(stream ? { stream: true } : {}), model: modelKey };
    const endpoint = stream ? path('/messages') : `${path('/messages')}/count_tokens`;
    const headers = headersForAnthropicMessagesCall(resolveHeaders(facts['request.headers']), facts['request.anthropicBeta']);
    return { modelKey, request: request('x-api-key', endpoint, { kind: 'json', value }, headers) };
  });
  const gemini = (stream: boolean) => buildHttpRequestStage<ProviderInput<GeminiGenerateContentPayload>>('buildRequest', requestKeys, facts => {
    const modelKey = facts['provider.model'].upstreamModelId.replace(/^models\//, '');
    const modelPath = `${path('/v1beta/models')}/${encodeURIComponent(modelKey)}`;
    const payload = facts['request.payload'];
    // Count generation fields through the envelope, which requires the full model name.
    // https://ai.google.dev/api/tokens#method:-models.counttokens
    const count: GeminiCountTokensPayload = { generateContentRequest: { ...payload, model: `models/${modelKey}` } };
    const endpoint = stream ? `${modelPath}:streamGenerateContent?alt=sse` : `${modelPath}:countTokens`;
    return {
      modelKey,
      request: request('x-goog-api-key', endpoint, { kind: 'json', value: stream ? payload : count }, resolveHeaders(facts['request.headers'])),
    };
  });

  const targeted = <Payload, Protocol extends string, Target extends { protocol: Protocol; path?: string }>(
    kind: string,
    targetOf: (model: ProviderInput<Payload>['provider.model']) => Target | undefined,
    paths: Readonly<Record<Protocol, string>>,
    serialize: (protocol: Protocol, modelKey: string, payload: Payload) => object,
  ) => defineStage<
    ProviderInput<Payload>,
    { 'request.http': HttpRequestFacts },
    { 'response.http': HttpResponseFacts },
    ProviderTargetOutput<Target>,
    ProviderServices
  >({
    name: 'buildRequest',
    through: {
      request: { needs: requestKeys, consumes: [], provides: ['request.http'] },
      response: { needs: ['response.http'], consumes: [], provides: ['response.modelKey', 'response.target'] },
    },
    async execute(facts, next) {
      const model = facts['provider.model'];
      const target = targetOf(model);
      if (target === undefined) throw new Error(`${kind} model ${model.id} has no outbound target`);
      const modelKey = model.upstreamModelId;
      const endpoint = target.path ?? paths[target.protocol];
      const body: ProviderRequestBody = { kind: 'json', value: serialize(target.protocol, modelKey, facts['request.payload']) };
      const outgoing = request('bearer', endpoint, body, resolveHeaders(facts['request.headers']));
      const back = await next({ ...facts, 'request.http': encodeHttpRequest(outgoing) });
      return { ...back, 'response.modelKey': modelKey, 'response.target': target };
    },
  });

  return {
    alphaSearch: assemble('alphaSearch', json('/alpha/search')),
    openaiCompletions: assemble('openaiCompletions', json('/completions')),
    openaiChatCompletions: assemble('openaiChatCompletions', parseSseStage('parseSse', parseOpenAIChatCompletionsStream), json('/chat/completions', true)),
    openaiResponses: assemble(
      'openaiResponses',
      parseSseStage('parseSse', parseOpenAIResponsesStream, {
        needs: ['request.action'],
        when: (facts: ProviderResponsesInput) => facts['request.action'] === 'generate',
      }),
      parseCompactionStage(),
      buildHttpRequestStage<ProviderResponsesInput>('buildRequest', responseKeys, facts => {
        const payload = facts['request.payload'];
        const modelKey = facts['provider.model'].upstreamModelId;
        const compact = facts['request.action'] === 'compact';
        const endpoint = compact ? `${path('/responses')}/compact` : path('/responses');
        const value = compact ? { ...toCompactPayloadShape(payload), model: modelKey } : { ...payload, stream: true, model: modelKey };
        return { modelKey, request: request('bearer', endpoint, { kind: 'json', value }, resolveHeaders(facts['request.headers'])) };
      }),
    ),
    anthropicMessages: assemble('anthropicMessages', parseSseStage('parseSse', parseAnthropicMessagesStream), anthropic(true)),
    anthropicMessagesCountTokens: assemble('anthropicMessagesCountTokens', anthropic(false)),
    geminiGenerateContent: assemble('geminiGenerateContent', parseSseStage('parseSse', parseGeminiGenerateContentStream), gemini(true)),
    geminiGenerateContentCountTokens: assemble('geminiGenerateContentCountTokens', gemini(false)),
    openaiEmbeddings: assemble('openaiEmbeddings', json('/embeddings')),
    openaiImagesGenerations: assemble('openaiImagesGenerations', json('/images/generations')),
    openaiImagesEdits: assemble('openaiImagesEdits', multipart<OpenAIImagesEditsRequest>('/images/edits', serializeOpenAIImagesEditsRequest)),
    openaiAudioTranscriptions: assemble('openaiAudioTranscriptions', multipart<OpenAIAudioTranscriptionRequest>('/audio/transcriptions', serializeModelFieldOpenAIAudioTranscriptionRequest)),
    rerank: assemble('rerank', targeted('Rerank', model => model.rerankTarget, DEFAULT_RERANK_PATHS,
      (protocol, modelKey, payload: CanonicalRerankRequest) => serializeRerankRequest(protocol, modelKey, payload))),
    decision: assemble('decision', targeted('Decision', model => model.decisionTarget, DEFAULT_DECISION_PATHS,
      (protocol, modelKey, payload: CanonicalDecisionRequest) => serializeDecisionRequest(protocol, modelKey, payload))),
  };
};
