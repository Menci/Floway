import type { AzureUpstreamConfigFacts, AzureUpstreamFacts } from './config.ts';
import { azureAnthropicBaseUrl, azureOpenAiV1BaseUrl, azureResourceRootUrl } from './endpoint.ts';
import { compose, defineStage, transform } from '@floway-dev/pipeline';
import { parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest, type CanonicalDecisionRequest } from '@floway-dev/protocols/decision';
import { parseOpenAIChatCompletionsStream, type OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAICompletionsPayload } from '@floway-dev/protocols/openai-completions';
import type { OpenAIEmbeddingsPayload } from '@floway-dev/protocols/openai-embeddings';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import { mapOpenAIResponsesTools, toCompactPayloadShape } from '@floway-dev/protocols/openai-responses';
import {
  httpTerminal,
  httpUrl,
  joinBaseAndPath,
  parseHttpOutcomeStage,
  parseResponsesStage,
  parseSseStage,
  rewriteHttpRequestStage,
  serializeModelPathOpenAIAudioTranscriptionRequest,
  serializeOpenAIImagesEditsRequest,
  setAnthropicBetaHeader,
  stripHttpHeaders,
  type OpenAIAudioTranscriptionRequest,
  type OpenAIImagesEditsRequest,
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
  type ProviderOpenAIImagesEditsOutput,
  type ProviderOpenAIImagesGenerationsOutput,
  type ProviderOpenAIResponsesOutput,
  type ProviderRequestBody,
  type ProviderResponsesInput,
  type ProviderServices,
} from '@floway-dev/provider';

type AzureInput<Payload> = ProviderInput<AzureUpstreamFacts, Payload>;
type AnthropicInput = ProviderAnthropicInput<AzureUpstreamFacts>;
type ResponsesInput = ProviderResponsesInput<AzureUpstreamFacts>;
type DecisionInput = AzureInput<CanonicalDecisionRequest>;

const requestKeys = ['provider.upstream', 'provider.model', 'request.http', 'request.payload'] as const;
const anthropicKeys = [...requestKeys, 'request.anthropicBeta'] as const;
const responsesKeys = [...requestKeys, 'request.action'] as const;
const responseKeys = ['response.http', 'response.modelKey'] as const;

const stripOpenAIHeaders = stripHttpHeaders(name => name === 'api-key' || name === 'content-type');
const anthropicHeaders = new Set(['x-api-key', 'anthropic-version', 'anthropic-beta', 'content-type']);
const stripAnthropicHeaders = stripHttpHeaders(name => anthropicHeaders.has(name));

// Azure OpenAI still enforces the former namespace-description minLength even
// though current OpenAI Responses permits an empty required string.
// https://github.com/openai/openai-openapi/commit/466c74a42f51c02f1927bc666815251dc53845dc
// https://github.com/openai/codex/issues/37380
const fillEmptyNamespaceDescriptions = defineStage<ResponsesInput, ResponsesInput, {}, {}>({
  name: 'fillEmptyNamespaceDescriptions',
  through: {
    request: { needs: ['request.payload', 'provider.model'], consumes: [], provides: ['request.payload'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: transform(() => ({
    request: facts => {
      let changed = false;
      const { model: _model, ...payload } = mapOpenAIResponsesTools(
        { ...facts['request.payload'], model: facts['provider.model'].id },
        tool => {
          if (tool.type !== 'namespace' || tool.description !== '') return tool;
          changed = true;
          return { ...tool, description: `Tools in the ${tool.name} namespace.` };
        },
      );
      return changed ? { ...facts, 'request.payload': payload } : facts;
    },
  })),
});

// https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest
const openaiRequest = (endpoint: string, { apiKey }: AzureUpstreamConfigFacts, body: ProviderRequestBody): ProviderHttpRequestUpdate => ({
  method: 'POST',
  url: httpUrl(endpoint),
  headers: () => [['api-key', apiKey]],
  body,
});

const openaiJson = (path: string, stream = false) => rewriteHttpRequestStage<AzureInput<object>>('buildRequest', requestKeys, facts => {
  const config = facts['provider.upstream'].config;
  const modelKey = facts['provider.model'].upstreamModelId;
  const value = { ...facts['request.payload'], ...(stream ? { stream: true } : {}), model: modelKey };
  const endpoint = joinBaseAndPath(azureOpenAiV1BaseUrl(config.endpoint), path);
  return { modelKey, request: openaiRequest(endpoint, config, { kind: 'json', value }) };
});

const anthropic = (stream: boolean) => rewriteHttpRequestStage<AnthropicInput>('buildRequest', anthropicKeys, facts => {
  const { endpoint, apiKey } = facts['provider.upstream'].config;
  const modelKey = facts['provider.model'].upstreamModelId;
  const value = { ...facts['request.payload'], ...(stream ? { stream: true } : {}), model: modelKey };
  const path = stream ? '/v1/messages' : '/v1/messages/count_tokens';
  return {
    modelKey,
    request: {
      method: 'POST',
      url: httpUrl(joinBaseAndPath(azureAnthropicBaseUrl(endpoint), path)),
      // https://docs.anthropic.com/en/api/versioning
      headers: () => setAnthropicBetaHeader([['x-api-key', apiKey], ['anthropic-version', '2023-06-01']], facts['request.anthropicBeta']),
      body: { kind: 'json', value },
    },
  };
});

const decisionTarget = (model: ProviderModelFacts) => {
  const target = model.decisionTarget;
  if (target === undefined) throw new Error(`Decision model ${model.id} has no outbound target`);
  return target;
};

// https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest
const imagePreview = '?api-version=preview';

export const azurePipelines = {
  openaiCompletions: compose<AzureInput<Omit<OpenAICompletionsPayload, 'model'>> & ProviderOpenAICompletionsOutput, ProviderServices>()('azure.openaiCompletions', {
    entry: requestKeys,
    exit: [...responseKeys, 'response.openaiCompletions'],
    stages: [parseHttpOutcomeStage('parseHttpOutcome', 'response.openaiCompletions'), openaiJson('/completions'), stripOpenAIHeaders],
    ending: httpTerminal,
  }),
  openaiChatCompletions: compose<AzureInput<Omit<OpenAIChatCompletionsPayloadEx, 'model'>> & ProviderOpenAIChatCompletionsOutput, ProviderServices>()('azure.openaiChatCompletions', {
    entry: requestKeys,
    exit: [...responseKeys, 'response.openaiChatCompletions'],
    stages: [
      parseSseStage('parseSse', 'response.openaiChatCompletions', parseOpenAIChatCompletionsStream),
      openaiJson('/chat/completions', true),
      stripOpenAIHeaders,
    ],
    ending: httpTerminal,
  }),
  openaiResponses: compose<ResponsesInput & ProviderOpenAIResponsesOutput, ProviderServices>()('azure.openaiResponses', {
    entry: responsesKeys,
    exit: [...responseKeys, 'response.openaiResponses'],
    stages: [
      fillEmptyNamespaceDescriptions,
      parseResponsesStage(),
      rewriteHttpRequestStage<ResponsesInput>('buildRequest', responsesKeys, facts => {
        const config = facts['provider.upstream'].config;
        const payload = facts['request.payload'];
        const modelKey = facts['provider.model'].upstreamModelId;
        const compact = facts['request.action'] === 'compact';
        const path = compact ? '/responses/compact' : '/responses';
        const value = compact ? { ...toCompactPayloadShape(payload), model: modelKey } : { ...payload, stream: true, model: modelKey };
        const endpoint = joinBaseAndPath(azureOpenAiV1BaseUrl(config.endpoint), path);
        return { modelKey, request: openaiRequest(endpoint, config, { kind: 'json', value }) };
      }),
      stripOpenAIHeaders,
    ],
    ending: httpTerminal,
  }),
  anthropicMessages: compose<AnthropicInput & ProviderAnthropicMessagesOutput, ProviderServices>()('azure.anthropicMessages', {
    entry: anthropicKeys,
    exit: [...responseKeys, 'response.anthropicMessages'],
    stages: [
      parseSseStage('parseSse', 'response.anthropicMessages', parseAnthropicMessagesStream),
      anthropic(true),
      stripAnthropicHeaders,
    ],
    ending: httpTerminal,
  }),
  anthropicMessagesCountTokens: compose<AnthropicInput & ProviderAnthropicCountTokensOutput, ProviderServices>()('azure.anthropicMessagesCountTokens', {
    entry: anthropicKeys,
    exit: [...responseKeys, 'response.anthropicMessagesCountTokens'],
    stages: [
      parseHttpOutcomeStage('parseHttpOutcome', 'response.anthropicMessagesCountTokens'),
      anthropic(false),
      stripAnthropicHeaders,
    ],
    ending: httpTerminal,
  }),
  openaiEmbeddings: compose<AzureInput<Omit<OpenAIEmbeddingsPayload, 'model'>> & ProviderOpenAIEmbeddingsOutput, ProviderServices>()('azure.openaiEmbeddings', {
    entry: requestKeys,
    exit: [...responseKeys, 'response.openaiEmbeddings'],
    stages: [parseHttpOutcomeStage('parseHttpOutcome', 'response.openaiEmbeddings'), openaiJson('/embeddings'), stripOpenAIHeaders],
    ending: httpTerminal,
  }),
  openaiImagesGenerations: compose<AzureInput<Omit<OpenAIImagesGenerationsPayload, 'model'>> & ProviderOpenAIImagesGenerationsOutput, ProviderServices>()('azure.openaiImagesGenerations', {
    entry: requestKeys,
    exit: [...responseKeys, 'response.openaiImagesGenerations'],
    stages: [
      parseHttpOutcomeStage('parseHttpOutcome', 'response.openaiImagesGenerations'),
      openaiJson(`/images/generations${imagePreview}`),
      stripOpenAIHeaders,
    ],
    ending: httpTerminal,
  }),
  openaiImagesEdits: compose<AzureInput<OpenAIImagesEditsRequest> & ProviderOpenAIImagesEditsOutput, ProviderServices>()('azure.openaiImagesEdits', {
    entry: requestKeys,
    exit: [...responseKeys, 'response.openaiImagesEdits'],
    stages: [
      parseHttpOutcomeStage('parseHttpOutcome', 'response.openaiImagesEdits'),
      rewriteHttpRequestStage<AzureInput<OpenAIImagesEditsRequest>>('buildRequest', requestKeys, facts => {
        const config = facts['provider.upstream'].config;
        const modelKey = facts['provider.model'].upstreamModelId;
        const body = serializeOpenAIImagesEditsRequest(facts['request.payload'], modelKey);
        const endpoint = joinBaseAndPath(azureOpenAiV1BaseUrl(config.endpoint), `/images/edits${imagePreview}`);
        return { modelKey, request: openaiRequest(endpoint, config, body) };
      }),
      stripOpenAIHeaders,
    ],
    ending: httpTerminal,
  }),
  openaiAudioTranscriptions: compose<AzureInput<OpenAIAudioTranscriptionRequest> & ProviderOpenAIAudioTranscriptionsOutput, ProviderServices>()('azure.openaiAudioTranscriptions', {
    entry: requestKeys,
    exit: [...responseKeys, 'response.openaiAudioTranscriptions'],
    stages: [
      parseHttpOutcomeStage('parseHttpOutcome', 'response.openaiAudioTranscriptions'),
      rewriteHttpRequestStage<AzureInput<OpenAIAudioTranscriptionRequest>>('buildRequest', requestKeys, facts => {
        const config = facts['provider.upstream'].config;
        const modelKey = facts['provider.model'].upstreamModelId;
        const body = serializeModelPathOpenAIAudioTranscriptionRequest(facts['request.payload']);
        // The operation selects the deployment in its resource-scoped path.
        // https://github.com/Azure/azure-rest-api-specs/blob/928047803788f7377fa003a26ba2bdc2e0fcccc0/specification/cognitiveservices/OpenAI.Inference/routes/audio_transcription.tsp#L19-L49
        const path = `/openai/deployments/${encodeURIComponent(modelKey)}/audio/transcriptions?api-version=2025-04-01-preview`;
        const endpoint = joinBaseAndPath(azureResourceRootUrl(config.endpoint), path);
        return { modelKey, request: openaiRequest(endpoint, config, body) };
      }),
      stripOpenAIHeaders,
    ],
    ending: httpTerminal,
  }),
  decision: compose<DecisionInput & ProviderDecisionOutput, ProviderServices>()('azure.decision', {
    entry: requestKeys,
    exit: [...responseKeys, 'response.decision'],
    stages: [
      parseHttpOutcomeStage('parseHttpOutcome', 'response.decision', {
        needs: ['provider.model'],
        extra: (facts: DecisionInput) => ({ target: decisionTarget(facts['provider.model']) }),
      }),
      rewriteHttpRequestStage<DecisionInput>('buildRequest', requestKeys, facts => {
        const config = facts['provider.upstream'].config;
        const model = facts['provider.model'];
        const target = decisionTarget(model);
        const modelKey = model.upstreamModelId;
        const endpoint = joinBaseAndPath(azureResourceRootUrl(config.endpoint), target.path ?? DEFAULT_DECISION_PATHS[target.protocol]);
        const value = serializeDecisionRequest(target.protocol, modelKey, facts['request.payload']);
        return { modelKey, request: openaiRequest(endpoint, config, { kind: 'json', value }) };
      }),
      stripOpenAIHeaders,
    ],
    ending: httpTerminal,
  }),
};
