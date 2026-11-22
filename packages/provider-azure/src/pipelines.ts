import type { AzureUpstreamConfig } from './config.ts';
import { azureAnthropicBaseUrl, azureOpenAiV1BaseUrl, azureResourceRootUrl } from './endpoint.ts';
import { fillEmptyNamespaceDescriptionsPayload } from './stages/openai-responses/fill-empty-namespace-descriptions.ts';
import { defineRequestStage, defineStage, pipeline, secret } from '@floway-dev/pipeline';
import type { HeaderEntry, StageEnv, WireHttpUrl } from '@floway-dev/pipeline';
import { parseAnthropicMessagesStream, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest } from '@floway-dev/protocols/decision';
import { parseOpenAIChatCompletionsStream, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream, toCompactPayloadShape, type CanonicalOpenAIResponsesPayload, type OpenAIResponsesCompactionResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type {
  HttpOutcome,
  ProviderPipelineAnthropicMessagesCountTokensInput,
  ProviderPipelineAnthropicMessagesInput,
  ProviderPipelineDecisionInput,
  ProviderPipelineDecisionOutcome,
  ProviderPipelineOpenAIAudioTranscriptionsInput,
  ProviderPipelineOpenAIChatCompletionsInput,
  ProviderPipelineOpenAICompletionsInput,
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
import {
  buildAudioTranscriptionMultipartBody,
  buildImagesEditsHttpBody,
  buildWireHttpUrl,
  headersForAnthropicMessagesCall,
  httpTerminal,
  parseUpstreamSseOutcome,
  readManagedBytes,
  wrapSensitiveHeaderEntries,
} from '@floway-dev/provider';

interface Azure {
  readonly id: string;
  readonly config: AzureUpstreamConfig;
}

type PipelineModelFacts = ProviderPipelineAnthropicMessagesInput['provider.model'];
type PipelineEnv = StageEnv<ProviderPipelineServices>;
type HttpFacts = {
  readonly 'request.http': UpstreamHttpRequest;
  readonly 'provider.modelKey': string;
};
type HeaderFacts = { readonly 'request.inboundHeaders': readonly HeaderEntry[] };
type InboundInput = HeaderFacts & {
  readonly 'provider.model': PipelineModelFacts;
  readonly 'request.payload': object;
};

const mergeHeaders = (base: readonly HeaderEntry[], overrides: readonly HeaderEntry[]): readonly HeaderEntry[] => {
  const names = new Set(overrides.map(([name]) => name.toLowerCase()));
  return [...base.filter(([name]) => !names.has(name.toLowerCase())), ...overrides];
};

const openAiHeaders = (azure: Azure, inbound: readonly HeaderEntry[]): readonly HeaderEntry[] =>
  wrapSensitiveHeaderEntries(mergeHeaders([['api-key', secret(azure.config.apiKey)]], inbound));

const anthropicHeaders = (azure: Azure, inbound: readonly HeaderEntry[], beta: readonly string[]): readonly HeaderEntry[] => {
  const ordinary = wrapSensitiveHeaderEntries(mergeHeaders([
    ['x-api-key', secret(azure.config.apiKey)],
    ['anthropic-version', '2023-06-01'],
  ], inbound).filter(([name]) => name.toLowerCase() !== 'anthropic-beta'));
  const nonEmptyBeta = beta.filter(value => value.length > 0);
  if (nonEmptyBeta.length === 0) return ordinary;
  const betaHeader = headersForAnthropicMessagesCall([], nonEmptyBeta)[0]!;
  return wrapSensitiveHeaderEntries([...ordinary, betaHeader]);
};

const openAiRequest = (azure: Azure, url: WireHttpUrl, inbound: readonly HeaderEntry[], body: object): UpstreamHttpRequest => ({
  method: 'POST',
  url,
  headers: openAiHeaders(azure, inbound),
  body: { kind: 'json', value: body },
});

const anthropicRequest = (
  azure: Azure,
  url: WireHttpUrl,
  inbound: readonly HeaderEntry[],
  beta: readonly string[],
  body: object,
): UpstreamHttpRequest => ({
  method: 'POST',
  url,
  headers: anthropicHeaders(azure, inbound, beta),
  body: { kind: 'json', value: body },
});

const openAiBase = (azure: Azure): string => azureOpenAiV1BaseUrl(azure.config.endpoint);
const anthropicBase = (azure: Azure): string => azureAnthropicBaseUrl(azure.config.endpoint);

const httpStage = <Input extends InboundInput, Out>(
  name: string,
  buildRequest: (facts: Readonly<Input>, modelKey: string) => UpstreamHttpRequest,
  finish: (http: HttpOutcome, facts: Readonly<Input>, modelKey: string, env: PipelineEnv) => Promise<Out> | Out,
) => defineStage<Input, HttpFacts, HttpOutcome, Out, never, ProviderPipelineServices>({
  name,
  provides: ['request.http', 'provider.modelKey'],
  execute: async (facts, next, env) => {
    const modelKey = facts['provider.model'].upstreamModelId;
    const http = await next({
      'request.http': buildRequest(facts, modelKey),
      'provider.modelKey': modelKey,
    });
    return await finish(http, facts, modelKey, env);
  },
});

const hasEmptyNamespaceDescription = (payload: Omit<CanonicalOpenAIResponsesPayload, 'model'>): boolean => {
  if (payload.tools?.some(tool => tool.type === 'namespace' && tool.description === '')) return true;
  return payload.input.some(item => (item.type === 'additional_tools' || item.type === 'tool_search_output')
    && item.tools.some(tool => tool.type === 'namespace' && tool.description === ''));
};

export const fillEmptyNamespaceDescriptions = defineRequestStage<
  ProviderPipelineOpenAIResponsesInput,
  { readonly 'request.payload': ProviderPipelineOpenAIResponsesInput['request.payload'] },
  'request.payload',
  ProviderPipelineServices
>({
  name: 'azure.openai-responses.fill-empty-namespace-descriptions',
  consumes: ['request.payload'],
  provides: ['request.payload'],
  execute: async (facts, next) => {
    const payload = facts['request.payload'];
    if (!hasEmptyNamespaceDescription(payload)) return await next({ 'request.payload': payload });
    const updated = fillEmptyNamespaceDescriptionsPayload(payload);
    return await next({ 'request.payload': updated });
  },
});

const readCompactResult = async (http: HttpOutcome): Promise<OpenAIResponsesCompactionResultEx> => {
  const bytes = await readManagedBytes(http.body);
  return JSON.parse(new TextDecoder().decode(bytes)) as OpenAIResponsesCompactionResultEx;
};

export const createAzurePipelines = (azure: Azure): ProviderPipelines => {
  const completions = pipeline<ProviderPipelineOpenAICompletionsInput>('azure.openai-completions')
    .use(httpStage(
      'azure.openai-completions.request',
      (facts, modelKey) => openAiRequest(azure, buildWireHttpUrl(openAiBase(azure), '/completions'), facts['request.inboundHeaders'], { ...facts['request.payload'], model: modelKey }),
      http => http,
    ))
    .end(httpTerminal(azure.id));

  const chatCompletions = pipeline<ProviderPipelineOpenAIChatCompletionsInput>('azure.openai-chat-completions')
    .use(httpStage<ProviderPipelineOpenAIChatCompletionsInput, ProviderPipelineStreamOutcome<OpenAIChatCompletionsStreamEvent>>(
      'azure.openai-chat-completions.request',
      (facts, modelKey) => openAiRequest(azure, buildWireHttpUrl(openAiBase(azure), '/chat/completions'), facts['request.inboundHeaders'], { ...facts['request.payload'], stream: true, model: modelKey }),
      async (http, _facts, _modelKey, env) => await parseUpstreamSseOutcome(http, parseOpenAIChatCompletionsStream, env),
    ))
    .end(httpTerminal(azure.id));

  const responses = pipeline<ProviderPipelineOpenAIResponsesInput>('azure.openai-responses')
    .use(fillEmptyNamespaceDescriptions)
    .use(httpStage<ProviderPipelineOpenAIResponsesInput, ProviderPipelineResponsesOutcome>(
      'azure.openai-responses.request',
      (facts, modelKey) => facts['request.action'] === 'generate'
        ? openAiRequest(azure, buildWireHttpUrl(openAiBase(azure), '/responses'), facts['request.inboundHeaders'], { ...facts['request.payload'], stream: true, model: modelKey })
        : openAiRequest(azure, buildWireHttpUrl(openAiBase(azure), '/responses/compact'), facts['request.inboundHeaders'], { ...toCompactPayloadShape(facts['request.payload']), model: modelKey }),
      async (http, facts, modelKey, env) => {
        if (facts['request.action'] === 'generate') {
          return {
            action: 'generate',
            ...await parseUpstreamSseOutcome<OpenAIResponsesStreamEventEx>(http, parseOpenAIResponsesStream, env),
          };
        }
        if (http.status < 200 || http.status >= 300) return { action: 'compact', ok: false, modelKey, http };
        return {
          action: 'compact',
          ok: true,
          result: await readCompactResult(http),
          modelKey,
          http: {
            status: http.status,
            statusText: http.statusText,
            headers: http.headers,
            timing: http.timing,
          },
        };
      },
    ))
    .end(httpTerminal(azure.id));

  const anthropicBaseUrl = anthropicBase(azure);
  const messages = pipeline<ProviderPipelineAnthropicMessagesInput>('azure.anthropic-messages')
    .use(httpStage<ProviderPipelineAnthropicMessagesInput, ProviderPipelineStreamOutcome<AnthropicMessagesStreamEventEx>>(
      'azure.anthropic-messages.request',
      (facts, modelKey) => anthropicRequest(azure, buildWireHttpUrl(anthropicBaseUrl, '/v1/messages'), facts['request.inboundHeaders'], facts['request.anthropicBeta'], { ...facts['request.payload'], stream: true, model: modelKey }),
      async (http, _facts, _modelKey, env) => await parseUpstreamSseOutcome(http, parseAnthropicMessagesStream, env),
    ))
    .end(httpTerminal(azure.id));

  const messagesCountTokens = pipeline<ProviderPipelineAnthropicMessagesCountTokensInput>('azure.anthropic-messages.count-tokens')
    .use(httpStage<ProviderPipelineAnthropicMessagesCountTokensInput, HttpOutcome>(
      'azure.anthropic-messages.count-tokens.request',
      (facts, modelKey) => anthropicRequest(azure, buildWireHttpUrl(anthropicBaseUrl, '/v1/messages/count_tokens'), facts['request.inboundHeaders'], facts['request.anthropicBeta'], { ...facts['request.payload'], model: modelKey }),
      http => http,
    ))
    .end(httpTerminal(azure.id));

  const embeddings = pipeline<ProviderPipelineOpenAIEmbeddingsInput>('azure.openai-embeddings')
    .use(httpStage(
      'azure.openai-embeddings.request',
      (facts, modelKey) => openAiRequest(azure, buildWireHttpUrl(openAiBase(azure), '/embeddings'), facts['request.inboundHeaders'], { ...facts['request.payload'], model: modelKey }),
      http => http,
    ))
    .end(httpTerminal(azure.id));

  const imagesGenerations = pipeline<ProviderPipelineOpenAIImagesGenerationsInput>('azure.openai-images-generations')
    .use(httpStage(
      'azure.openai-images-generations.request',
      (facts, modelKey) => openAiRequest(azure, buildWireHttpUrl(openAiBase(azure), '/images/generations', [['api-version', 'preview']]), facts['request.inboundHeaders'], { ...facts['request.payload'], model: modelKey }),
      http => http,
    ))
    .end(httpTerminal(azure.id));

  const imagesEdits = pipeline<ProviderPipelineOpenAIImagesEditsInput>('azure.openai-images-edits')
    .use(httpStage<ProviderPipelineOpenAIImagesEditsInput, HttpOutcome>(
      'azure.openai-images-edits.request',
      (facts, modelKey) => ({
        method: 'POST',
        url: buildWireHttpUrl(openAiBase(azure), '/images/edits', [['api-version', 'preview']]),
        headers: openAiHeaders(azure, facts['request.inboundHeaders']),
        body: buildImagesEditsHttpBody(facts['request.payload'], modelKey),
      }),
      http => http,
    ))
    .end(httpTerminal(azure.id));

  const audioTranscriptions = pipeline<ProviderPipelineOpenAIAudioTranscriptionsInput>('azure.openai-audio-transcriptions')
    .use(httpStage<ProviderPipelineOpenAIAudioTranscriptionsInput, HttpOutcome>(
      'azure.openai-audio-transcriptions.request',
      (facts, modelKey) => ({
        method: 'POST',
        // Azure selects the deployment in the operation path. The 2025-04
        // preview route covers both Whisper and GPT transcription deployments,
        // and every admitted endpoint shape reduces to the resource host.
        // https://github.com/Azure/azure-rest-api-specs/blob/b0a48bcbffead733affe03944ef09f5e8d12f8c8/specification/cognitiveservices/OpenAI.Inference/models/audio/audio_transcription.tsp#L119-L126
        // https://github.com/Azure/azure-rest-api-specs/blob/928047803788f7377fa003a26ba2bdc2e0fcccc0/specification/cognitiveservices/OpenAI.Inference/routes/audio_transcription.tsp#L19-L49
        url: buildWireHttpUrl(
          azureResourceRootUrl(azure.config.endpoint),
          `/openai/deployments/${encodeURIComponent(modelKey)}/audio/transcriptions`,
          [['api-version', '2025-04-01-preview']],
        ),
        headers: openAiHeaders(azure, facts['request.inboundHeaders']),
        body: buildAudioTranscriptionMultipartBody(facts['request.payload'], { type: 'omit' }),
      }),
      http => http,
    ))
    .end(httpTerminal(azure.id));

  const decision = pipeline<ProviderPipelineDecisionInput>('azure.decision')
    .use(defineStage<ProviderPipelineDecisionInput, HttpFacts, HttpOutcome, ProviderPipelineDecisionOutcome, never, ProviderPipelineServices>({
      name: 'azure.decision.request',
      provides: ['request.http', 'provider.modelKey'],
      execute: async (facts, next) => {
        const target = facts['provider.model'].decisionTarget;
        if (target === undefined) throw new Error(`Decision model ${facts['provider.model'].id} has no outbound target`);
        const modelKey = facts['provider.model'].upstreamModelId;
        const http = await next({
          'request.http': openAiRequest(
            azure,
            buildWireHttpUrl(azureResourceRootUrl(azure.config.endpoint), target.path ?? DEFAULT_DECISION_PATHS[target.protocol]),
            facts['request.inboundHeaders'],
            serializeDecisionRequest(target.protocol, modelKey, facts['request.payload']),
          ),
          'provider.modelKey': modelKey,
        });
        return { target, modelKey, http };
      },
    }))
    .end(httpTerminal(azure.id));

  return {
    openaiCompletions: completions,
    openaiChatCompletions: chatCompletions,
    openaiResponses: responses,
    anthropicMessages: messages,
    anthropicMessagesCountTokens: messagesCountTokens,
    openaiEmbeddings: embeddings,
    openaiImagesGenerations: imagesGenerations,
    openaiImagesEdits: imagesEdits,
    openaiAudioTranscriptions: audioTranscriptions,
    decision,
  };
};
