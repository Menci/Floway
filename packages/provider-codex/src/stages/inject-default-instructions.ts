import { codexModelUsesResponsesLite } from '../models.ts';
import type { CodexAccountFacts } from '../pipeline-facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ProviderChatResponse, ProviderChatServices, ProviderModelFacts } from '@floway-dev/provider';

type Request = CodexAccountFacts<'openaiResponses' | 'openaiResponsesCompact'>;

// Standard ChatGPT-subscription models reject missing or empty `instructions`.
// Lite models accept an empty top-level field because base instructions live
// in a tagged developer input item, when the caller supplies one.
// https://github.com/im4codes/imcodes/blob/5f769d933dfd679e3a4d670183b0384a1baf62cd/src/agent/providers/codex-sdk.ts#L560-L579
// https://github.com/openai/codex/blob/0462dcc062b822bb8fff16cc31ce6eeab69823b9/codex-rs/core/src/client.rs#L902-L938
export const defaultInstructionsPayload = <P extends Omit<CanonicalOpenAIResponsesPayload, 'model'>>(payload: P, model: ProviderModelFacts): P => {
  const instructions = payload.instructions;
  return !codexModelUsesResponsesLite(model) && (instructions === undefined || instructions === null || instructions === '')
    ? { ...payload, instructions: "You're a helpful assistant." }
    : payload;
};

export const injectCodexDefaultInstructions = defineStage<Request, Request, ProviderChatResponse<'openaiResponses'>, ProviderChatResponse<'openaiResponses'>, ProviderChatServices>({
  name: 'injectCodexDefaultInstructions',
  through: {
    request: { needs: ['request.provider.payload', 'request.provider.model'], consumes: ['request.provider.payload'], provides: ['request.provider.payload'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => move({
    ...await next(move({ ...facts, 'request.provider.payload': defaultInstructionsPayload(facts['request.provider.payload'], facts['request.provider.model']) })),
  }),
});
