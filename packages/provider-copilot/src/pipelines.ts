import type { CopilotAuth } from './auth.ts';
import { COMPACTION_TRIGGER } from './compaction.ts';
import { anthropicCountTokensStages, anthropicMessagesStages } from './stages/anthropic-messages/index.ts';
import { openAIChatCompletionsStages, type ChatInput } from './stages/openai-chat-completions/index.ts';
import { openAIResponsesStages } from './stages/openai-responses/index.ts';
import { authStage, quotaStage, requestStage, selectModelStage, unchanged, wireHeadersStage } from './stages/shared/stages.ts';
import { compose, defineStage, transform } from '@floway-dev/pipeline';
import { parseAnthropicMessagesStream, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { DecisionTarget } from '@floway-dev/protocols/common';
import { DEFAULT_DECISION_PATHS, serializeDecisionRequest, type CanonicalDecisionRequest } from '@floway-dev/protocols/decision';
import { parseOpenAIChatCompletionsStream, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIEmbeddingsPayload } from '@floway-dev/protocols/openai-embeddings';
import type { OpenAIImagesGenerationsPayload } from '@floway-dev/protocols/openai-images';
import { httpTerminal, parseSseStage, serializeOpenAIImagesEditsRequest, type OpenAIImagesEditsRequest, type ProviderAnthropicInput, type ProviderHttpOutput, type ProviderInput, type ProviderModelFacts, type ProviderPipelines, type ProviderResponsesInput, type ProviderResponsesOutput, type ProviderServices, type ProviderStreamOutput, type ProviderTargetOutput } from '@floway-dev/provider';

type EmbeddingsInput = ProviderInput<Omit<OpenAIEmbeddingsPayload, 'model'>>;
type ImagesGenerationsInput = ProviderInput<Omit<OpenAIImagesGenerationsPayload, 'model'>>;
type ImagesEditsInput = ProviderInput<OpenAIImagesEditsRequest>;
type DecisionInput = ProviderInput<CanonicalDecisionRequest>;
type DecisionOutput = ProviderTargetOutput<DecisionTarget>;

const decisionTarget = (model: ProviderModelFacts): DecisionTarget => {
  const { decisionTarget } = model;
  if (decisionTarget === undefined) throw new Error(`Decision model ${model.id} has no outbound target`);
  return decisionTarget;
};

const exposeDecisionTarget = defineStage<DecisionInput, DecisionInput, ProviderHttpOutput, DecisionOutput, ProviderServices>({
  name: 'decision-target',
  through: {
    request: { ...unchanged, needs: ['provider.model'] },
    response: { ...unchanged, provides: ['response.target'] },
  },
  async execute(facts, next) {
    const target = decisionTarget(facts['provider.model']);
    return { ...await next(facts), 'response.target': target };
  },
});

// Copilot rejects scalar text input on /embeddings.
// https://github.com/ericc-ch/copilot-api/blob/0ea08febdd7e3e055b03dd298bf57e669500b5c1/src/services/copilot/create-embeddings.ts#L19-L21
const embeddingsInput = defineStage<EmbeddingsInput, EmbeddingsInput, ProviderHttpOutput, ProviderHttpOutput, ProviderServices>({
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

export const createCopilotPipelines = (copilot: CopilotAuth): ProviderPipelines => {
  const transport = [quotaStage(copilot.id), authStage(copilot)];
  const ending = httpTerminal(copilot.id);
  return {
    openaiChatCompletions: compose<ChatInput, ProviderStreamOutput<OpenAIChatCompletionsStreamEvent>, ProviderServices>('copilot.openai-chat-completions', {
      stages: [
        ...openAIChatCompletionsStages,
        parseSseStage('parse-sse', parseOpenAIChatCompletionsStream),
        ...transport,
        requestStage<ChatInput>('build-request', [], '/chat/completions', (facts, model) => ({
          kind: 'json', value: { ...facts['request.payload'], stream: true, model },
        })),
        wireHeadersStage,
      ],
      ending,
    }),
    openaiResponses: compose<ProviderResponsesInput, ProviderResponsesOutput, ProviderServices>('copilot.openai-responses', {
      stages: [
        ...openAIResponsesStages,
        ...transport,
        requestStage<ProviderResponsesInput>('build-request', ['request.action'], '/responses', (facts, model) => {
          const payload = facts['request.payload'];
          return {
            kind: 'json',
            value: facts['request.action'] === 'compact'
              ? { ...payload, input: [...payload.input, COMPACTION_TRIGGER], stream: false, model }
              : { ...payload, stream: true, model },
          };
        }),
        wireHeadersStage,
      ],
      ending,
    }),
    anthropicMessages: compose<ProviderAnthropicInput, ProviderStreamOutput<AnthropicMessagesStreamEventEx>, ProviderServices>('copilot.anthropic-messages', {
      stages: [
        ...anthropicMessagesStages,
        parseSseStage('parse-sse', parseAnthropicMessagesStream),
        ...transport,
        requestStage<ProviderAnthropicInput>('build-request', [], '/v1/messages', (facts, model) => ({
          kind: 'json', value: { ...facts['request.payload'], stream: true, model },
        })),
        wireHeadersStage,
      ],
      ending,
    }),
    anthropicMessagesCountTokens: compose<ProviderAnthropicInput, ProviderHttpOutput, ProviderServices>('copilot.anthropic-messages-count-tokens', {
      stages: [
        ...anthropicCountTokensStages,
        ...transport,
        requestStage<ProviderAnthropicInput>('build-request', [], '/v1/messages/count_tokens', (facts, model) => ({
          kind: 'json', value: { ...facts['request.payload'], model },
        })),
        wireHeadersStage,
      ],
      ending,
    }),
    openaiEmbeddings: compose<EmbeddingsInput, ProviderHttpOutput, ProviderServices>('copilot.openai-embeddings', {
      stages: [
        selectModelStage('openaiEmbeddings', [], () => ({})),
        embeddingsInput,
        ...transport,
        requestStage<EmbeddingsInput>('build-request', [], '/embeddings', (facts, model) => ({
          kind: 'json', value: { ...facts['request.payload'], model },
        })),
        wireHeadersStage,
      ],
      ending,
    }),
    openaiImagesGenerations: compose<ImagesGenerationsInput, ProviderHttpOutput, ProviderServices>('copilot.openai-images-generations', {
      stages: [
        selectModelStage('openaiImagesGenerations', [], () => ({})),
        ...transport,
        requestStage<ImagesGenerationsInput>('build-request', [], '/v1/images/generations', (facts, model) => ({
          kind: 'json', value: { ...facts['request.payload'], model },
        })),
        wireHeadersStage,
      ],
      ending,
    }),
    openaiImagesEdits: compose<ImagesEditsInput, ProviderHttpOutput, ProviderServices>('copilot.openai-images-edits', {
      stages: [
        selectModelStage('openaiImagesEdits', [], () => ({})),
        ...transport,
        requestStage<ImagesEditsInput>('build-request', [], '/v1/images/edits', (facts, model) =>
          serializeOpenAIImagesEditsRequest(facts['request.payload'], model)),
        wireHeadersStage,
      ],
      ending,
    }),
    decision: compose<DecisionInput, DecisionOutput, ProviderServices>('copilot.decision', {
      stages: [
        exposeDecisionTarget,
        selectModelStage('decision', [], () => ({})),
        ...transport,
        requestStage<DecisionInput>('build-request', ['provider.model'], facts => {
          const target = decisionTarget(facts['provider.model']);
          return target.path ?? DEFAULT_DECISION_PATHS[target.protocol];
        }, (facts, model) => ({
          kind: 'json',
          value: serializeDecisionRequest(decisionTarget(facts['provider.model']).protocol, model, facts['request.payload']),
        })),
        wireHeadersStage,
      ],
      ending,
    }),
  };
};
