import { COMPACTION_TRIGGER } from './compaction.ts';
import type { CopilotUpstreamFacts } from './config.ts';
import type { CopilotServices } from './service.ts';
import { anthropicCountTokensStages, anthropicMessagesStages } from './stages/anthropic-messages/index.ts';
import { openAIChatCompletionsStages, type ChatInput } from './stages/openai-chat-completions/index.ts';
import { openAIResponsesStages } from './stages/openai-responses/index.ts';
import { keepCopilotWireHeader, quotaStage, requestStage, selectModelStage, unchanged, wireHeadersStage } from './stages/shared/stages.ts';
import { compose, defineStage, transform } from '@floway-dev/pipeline';
import { parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import type { DecisionTarget } from '@floway-dev/protocols/common';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest, type CanonicalDecisionRequest } from '@floway-dev/protocols/decision';
import { parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIEmbeddingsPayload } from '@floway-dev/protocols/openai-embeddings';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import { httpTerminal, parseHttpOutcomeStage, parseResponsesStage, parseSseStage, serializeOpenAIImagesEditsRequest, stripHttpHeaders, type OpenAIImagesEditsRequest, type ProviderAnthropicCountTokensOutput, type ProviderAnthropicInput, type ProviderAnthropicMessagesOutput, type ProviderDecisionOutput, type ProviderInput, type ProviderModelFacts, type ProviderOpenAIChatCompletionsOutput, type ProviderOpenAIEmbeddingsOutput, type ProviderOpenAIImagesEditsOutput, type ProviderOpenAIImagesGenerationsOutput, type ProviderOpenAIResponsesOutput, type ProviderPipelines, type ProviderResponsesInput } from '@floway-dev/provider';

type ResponsesInput = ProviderResponsesInput<CopilotUpstreamFacts>;
type AnthropicInput = ProviderAnthropicInput<CopilotUpstreamFacts>;
type EmbeddingsInput = ProviderInput<CopilotUpstreamFacts, Omit<OpenAIEmbeddingsPayload, 'model'>>;
type ImagesGenerationsInput = ProviderInput<CopilotUpstreamFacts, Omit<OpenAIImagesGenerationsPayload, 'model'>>;
type ImagesEditsInput = ProviderInput<CopilotUpstreamFacts, OpenAIImagesEditsRequest>;
type DecisionInput = ProviderInput<CopilotUpstreamFacts, CanonicalDecisionRequest>;

const decisionTarget = (model: ProviderModelFacts): DecisionTarget => {
  const { decisionTarget } = model;
  if (decisionTarget === undefined) throw new Error(`Decision model ${model.id} has no outbound target`);
  return decisionTarget;
};

// Copilot rejects scalar text input on /embeddings.
// https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/services/copilot/create-embeddings.ts#L19-L21
const embeddingsInput = defineStage<EmbeddingsInput, EmbeddingsInput, {}, {}>({
  name: 'normalize-embeddings-input',
  through: {
    request: { needs: ['request.payload'], consumes: [], provides: ['request.payload'] },
    response: unchanged,
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.payload'];
      return typeof payload.input === 'string'
        ? { ...facts, 'request.payload': { ...payload, input: [payload.input] } }
        : facts;
    },
  })),
});

const entry = ['provider.upstream', 'provider.model', 'request.http', 'request.payload'] as const;
const exit = ['response.http', 'response.modelKey'] as const;

const keepChatHeader = (name: string) => keepCopilotWireHeader(name) || name === 'copilot-vision-request' || name === 'x-initiator';
const keepAnthropicHeader = (name: string) => keepChatHeader(name) || name === 'anthropic-beta' || name === 'anthropic-version';
const stripDefaultWireHeaders = stripHttpHeaders(keepCopilotWireHeader);
const stripChatWireHeaders = stripHttpHeaders(keepChatHeader);
const stripMessagesWireHeaders = stripHttpHeaders(name => keepAnthropicHeader(name) || name === 'x-interaction-id');
const stripCountTokensWireHeaders = stripHttpHeaders(keepAnthropicHeader);

export const copilotPipelines = {
  openaiChatCompletions: compose<ChatInput & ProviderOpenAIChatCompletionsOutput, CopilotServices>()('copilot.openai-chat-completions', {
    entry,
    exit: [...exit, 'response.openaiChatCompletions'],
    stages: [
      wireHeadersStage,
      ...openAIChatCompletionsStages,
      parseSseStage('parse-sse', 'response.openaiChatCompletions', parseOpenAIChatCompletionsStream),
      quotaStage,
      requestStage<ChatInput>([], '/chat/completions', (facts, model) => ({
        kind: 'json', value: { ...facts['request.payload'], stream: true, model },
      })),
      stripChatWireHeaders,
    ],
    ending: httpTerminal,
  }),
  openaiResponses: compose<ResponsesInput & ProviderOpenAIResponsesOutput, CopilotServices>()('copilot.openai-responses', {
    entry: [...entry, 'request.action'],
    exit: [...exit, 'response.openaiResponses'],
    stages: [
      wireHeadersStage,
      ...openAIResponsesStages,
      parseResponsesStage(),
      quotaStage,
      requestStage<ResponsesInput>(['request.action'], '/responses', (facts, model) => {
        const payload = facts['request.payload'];
        return {
          kind: 'json',
          value: facts['request.action'] === 'compact'
            ? { ...payload, input: [...payload.input, COMPACTION_TRIGGER], stream: false, model }
            : { ...payload, stream: true, model },
        };
      }),
      stripChatWireHeaders,
    ],
    ending: httpTerminal,
  }),
  anthropicMessages: compose<AnthropicInput & ProviderAnthropicMessagesOutput, CopilotServices>()('copilot.anthropic-messages', {
    entry: [...entry, 'request.anthropicBeta'],
    exit: [...exit, 'response.anthropicMessages'],
    stages: [
      wireHeadersStage,
      ...anthropicMessagesStages,
      parseSseStage('parse-sse', 'response.anthropicMessages', parseAnthropicMessagesStream),
      quotaStage,
      requestStage<AnthropicInput>([], '/v1/messages', (facts, model) => ({
        kind: 'json', value: { ...facts['request.payload'], stream: true, model },
      })),
      stripMessagesWireHeaders,
    ],
    ending: httpTerminal,
  }),
  anthropicMessagesCountTokens: compose<AnthropicInput & ProviderAnthropicCountTokensOutput, CopilotServices>()('copilot.anthropic-messages-count-tokens', {
    entry: [...entry, 'request.anthropicBeta'],
    exit: [...exit, 'response.anthropicMessagesCountTokens'],
    stages: [
      wireHeadersStage,
      ...anthropicCountTokensStages,
      parseHttpOutcomeStage('parse-http-outcome', 'response.anthropicMessagesCountTokens'),
      quotaStage,
      requestStage<AnthropicInput>([], '/v1/messages/count_tokens', (facts, model) => ({
        kind: 'json', value: { ...facts['request.payload'], model },
      })),
      stripCountTokensWireHeaders,
    ],
    ending: httpTerminal,
  }),
  openaiEmbeddings: compose<EmbeddingsInput & ProviderOpenAIEmbeddingsOutput, CopilotServices>()('copilot.openai-embeddings', {
    entry,
    exit: [...exit, 'response.openaiEmbeddings'],
    stages: [
      wireHeadersStage,
      selectModelStage('openaiEmbeddings', [], () => ({})),
      embeddingsInput,
      parseHttpOutcomeStage('parse-http-outcome', 'response.openaiEmbeddings'),
      quotaStage,
      requestStage<EmbeddingsInput>([], '/embeddings', (facts, model) => ({
        kind: 'json', value: { ...facts['request.payload'], model },
      })),
      stripDefaultWireHeaders,
    ],
    ending: httpTerminal,
  }),
  openaiImagesGenerations: compose<ImagesGenerationsInput & ProviderOpenAIImagesGenerationsOutput, CopilotServices>()('copilot.openai-images-generations', {
    entry,
    exit: [...exit, 'response.openaiImagesGenerations'],
    stages: [
      wireHeadersStage,
      selectModelStage('openaiImagesGenerations', [], () => ({})),
      parseHttpOutcomeStage('parse-http-outcome', 'response.openaiImagesGenerations'),
      quotaStage,
      requestStage<ImagesGenerationsInput>([], '/v1/images/generations', (facts, model) => ({
        kind: 'json', value: { ...facts['request.payload'], model },
      })),
      stripDefaultWireHeaders,
    ],
    ending: httpTerminal,
  }),
  openaiImagesEdits: compose<ImagesEditsInput & ProviderOpenAIImagesEditsOutput, CopilotServices>()('copilot.openai-images-edits', {
    entry,
    exit: [...exit, 'response.openaiImagesEdits'],
    stages: [
      wireHeadersStage,
      selectModelStage('openaiImagesEdits', [], () => ({})),
      parseHttpOutcomeStage('parse-http-outcome', 'response.openaiImagesEdits'),
      quotaStage,
      requestStage<ImagesEditsInput>([], '/v1/images/edits', (facts, model) =>
        serializeOpenAIImagesEditsRequest(facts['request.payload'], model)),
      stripDefaultWireHeaders,
    ],
    ending: httpTerminal,
  }),
  decision: compose<DecisionInput & ProviderDecisionOutput, CopilotServices>()('copilot.decision', {
    entry,
    exit: [...exit, 'response.decision'],
    stages: [
      wireHeadersStage,
      selectModelStage('decision', [], () => ({})),
      parseHttpOutcomeStage('parse-http-outcome', 'response.decision', {
        needs: ['provider.model'],
        extra: (facts: DecisionInput) => ({ target: decisionTarget(facts['provider.model']) }),
      }),
      quotaStage,
      requestStage<DecisionInput>(['provider.model'], facts => {
        const target = decisionTarget(facts['provider.model']);
        return target.path ?? DEFAULT_DECISION_PATHS[target.protocol];
      }, (facts, model) => ({
        kind: 'json',
        value: serializeDecisionRequest(decisionTarget(facts['provider.model']).protocol, model, facts['request.payload']),
      })),
      stripDefaultWireHeaders,
    ],
    ending: httpTerminal,
  }),
} satisfies ProviderPipelines<CopilotUpstreamFacts, CopilotServices>;
