import type { AzureUpstreamConfig } from './config.ts';
import { azureAnthropicBaseUrl, azureOpenAiV1BaseUrl, azureResourceRootUrl } from './endpoint.ts';
import { compose, defineStage, secret, transform, type Stage } from '@floway-dev/pipeline';
import { parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import type { DecisionTarget } from '@floway-dev/protocols/common';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest, type CanonicalDecisionRequest } from '@floway-dev/protocols/decision';
import { parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { mapOpenAIResponsesTools, parseOpenAIResponsesStream, toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';
import {
  buildHttpRequestStage,
  encodeHttpRequest,
  headersForAnthropicMessagesCall,
  httpTerminal,
  httpUrl,
  joinBaseAndPath,
  parseCompactionStage,
  parseSseStage,
  serializeModelPathOpenAIAudioTranscriptionRequest,
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

// Azure OpenAI still enforces the former namespace-description minLength even
// though current OpenAI Responses permits an empty required string.
// https://github.com/openai/openai-openapi/commit/466c74a42f51c02f1927bc666815251dc53845dc
// https://github.com/openai/codex/issues/37380
const fillEmptyNamespaceDescriptions = defineStage<ProviderResponsesInput, ProviderResponsesInput, {}, {}>({
  name: 'fillEmptyNamespaceDescriptions',
  through: {
    request: { needs: ['request.payload', 'provider.model'], consumes: ['request.payload'], provides: ['request.payload'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: transform(() => ({
    request: facts => {
      const { model: _model, ...payload } = mapOpenAIResponsesTools(
        { ...facts['request.payload'], model: facts['provider.model'].id },
        tool => tool.type === 'namespace' && tool.description === ''
          ? { ...tool, description: `Tools in the ${tool.name} namespace.` }
          : tool,
      );
      return { ...facts, 'request.payload': payload };
    },
  })),
});

export const createAzurePipelines = (upstreamId: string, config: AzureUpstreamConfig): ProviderPipelines => {
  const ending = httpTerminal(upstreamId);
  const assemble = <In, Out>(operation: string, ...stages: Stage<ProviderServices>[]) =>
    compose<In, Out, ProviderServices>(`${upstreamId}.${operation}`, { stages, ending });
  const openAiBase = azureOpenAiV1BaseUrl(config.endpoint);
  const anthropicBase = azureAnthropicBaseUrl(config.endpoint);
  const resourceRoot = azureResourceRootUrl(config.endpoint);
  const apiKey = secret(config.apiKey);
  const request = (
    endpoint: string, body: ProviderRequestBody, extra: readonly HeaderEntry[], surface: 'openai' | 'anthropic' = 'openai',
  ): ProviderHttpRequest => {
    // https://docs.anthropic.com/en/api/versioning
    const defaults: readonly HeaderEntry[] = surface === 'anthropic'
      ? [['x-api-key', apiKey], ['anthropic-version', '2023-06-01']]
      : [['api-key', apiKey]];
    const headers = new Map<string, HeaderEntry[1]>(defaults);
    for (const [name, value] of extra) headers.set(name.toLowerCase(), value);
    return { method: 'POST', url: httpUrl(endpoint), headers: [...headers], body };
  };
  const openaiJson = (path: string, stream = false) => buildHttpRequestStage<ProviderInput<object>>('buildRequest', requestKeys, facts => {
    const modelKey = facts['provider.model'].upstreamModelId;
    const value = { ...facts['request.payload'], ...(stream ? { stream: true } : {}), model: modelKey };
    return {
      modelKey,
      request: request(joinBaseAndPath(openAiBase, path), { kind: 'json', value }, facts['request.headers']),
    };
  });
  const anthropic = (stream: boolean) => buildHttpRequestStage<ProviderAnthropicInput>('buildRequest', anthropicKeys, facts => {
    const modelKey = facts['provider.model'].upstreamModelId;
    const value = { ...facts['request.payload'], ...(stream ? { stream: true } : {}), model: modelKey };
    const path = stream ? '/v1/messages' : '/v1/messages/count_tokens';
    const headers = headersForAnthropicMessagesCall(facts['request.headers'], facts['request.anthropicBeta']);
    return { modelKey, request: request(joinBaseAndPath(anthropicBase, path), { kind: 'json', value }, headers, 'anthropic') };
  });

  // https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest
  const imagePreview = '?api-version=preview';

  return {
    openaiCompletions: assemble('openaiCompletions', openaiJson('/completions')),
    openaiChatCompletions: assemble('openaiChatCompletions', parseSseStage('parseSse', parseOpenAIChatCompletionsStream), openaiJson('/chat/completions', true)),
    openaiResponses: assemble(
      'openaiResponses',
      fillEmptyNamespaceDescriptions,
      parseSseStage('parseSse', parseOpenAIResponsesStream, {
        needs: ['request.action'],
        when: (facts: ProviderResponsesInput) => facts['request.action'] === 'generate',
      }),
      parseCompactionStage(),
      buildHttpRequestStage<ProviderResponsesInput>('buildRequest', responseKeys, facts => {
        const payload = facts['request.payload'];
        const modelKey = facts['provider.model'].upstreamModelId;
        const compact = facts['request.action'] === 'compact';
        const path = compact ? '/responses/compact' : '/responses';
        const value = compact ? { ...toCompactPayloadShape(payload), model: modelKey } : { ...payload, stream: true, model: modelKey };
        return {
          modelKey,
          request: request(joinBaseAndPath(openAiBase, path), { kind: 'json', value }, facts['request.headers']),
        };
      }),
    ),
    anthropicMessages: assemble('anthropicMessages', parseSseStage('parseSse', parseAnthropicMessagesStream), anthropic(true)),
    anthropicMessagesCountTokens: assemble('anthropicMessagesCountTokens', anthropic(false)),
    openaiEmbeddings: assemble('openaiEmbeddings', openaiJson('/embeddings')),
    openaiImagesGenerations: assemble('openaiImagesGenerations', openaiJson(`/images/generations${imagePreview}`)),
    openaiImagesEdits: assemble('openaiImagesEdits', buildHttpRequestStage<ProviderInput<OpenAIImagesEditsRequest>>('buildRequest', requestKeys, facts => {
      const modelKey = facts['provider.model'].upstreamModelId;
      const body = serializeOpenAIImagesEditsRequest(facts['request.payload'], modelKey);
      return {
        modelKey,
        request: request(joinBaseAndPath(openAiBase, `/images/edits${imagePreview}`), body, facts['request.headers']),
      };
    })),
    openaiAudioTranscriptions: assemble('openaiAudioTranscriptions', buildHttpRequestStage<ProviderInput<OpenAIAudioTranscriptionRequest>>('buildRequest', requestKeys, facts => {
      const modelKey = facts['provider.model'].upstreamModelId;
      const body = serializeModelPathOpenAIAudioTranscriptionRequest(facts['request.payload']);
      // The operation selects the deployment in its resource-scoped path.
      // https://github.com/Azure/azure-rest-api-specs/blob/928047803788f7377fa003a26ba2bdc2e0fcccc0/specification/cognitiveservices/OpenAI.Inference/routes/audio_transcription.tsp#L19-L49
      const endpoint = `/openai/deployments/${encodeURIComponent(modelKey)}/audio/transcriptions?api-version=2025-04-01-preview`;
      return { modelKey, request: request(joinBaseAndPath(resourceRoot, endpoint), body, facts['request.headers']) };
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
        const endpoint = joinBaseAndPath(resourceRoot, target.path ?? DEFAULT_DECISION_PATHS[target.protocol]);
        const body: ProviderRequestBody = { kind: 'json', value: serializeDecisionRequest(target.protocol, modelKey, facts['request.payload']) };
        const outgoing = request(endpoint, body, facts['request.headers']);
        const back = await next({ ...facts, 'request.http': encodeHttpRequest(outgoing) });
        return { ...back, 'response.modelKey': modelKey, 'response.target': target };
      },
    })),
  };
};
