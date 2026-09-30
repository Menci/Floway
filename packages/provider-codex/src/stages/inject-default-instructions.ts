import type { CodexAccountFacts } from '../pipeline-facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ProviderChatResponse, ProviderChatServices } from '@floway-dev/provider';

type Request = CodexAccountFacts<'openaiResponses' | 'openaiResponsesCompact'>;

// ChatGPT-subscription catalog models reject missing or empty `instructions`.
// Native and translated callers may omit the field, so the provider supplies a
// neutral value at its boundary. Other values remain upstream-owned validation.
// https://github.com/im4codes/imcodes/blob/5f769d933dfd679e3a4d670183b0384a1baf62cd/src/agent/providers/codex-sdk.ts#L560-L579
export const defaultInstructionsPayload = <P extends Omit<CanonicalOpenAIResponsesPayload, 'model'>>(payload: P): P => {
  const instructions = payload.instructions;
  return instructions === undefined || instructions === null || instructions === ''
    ? { ...payload, instructions: "You're a helpful assistant." }
    : payload;
};

export const injectCodexDefaultInstructions = defineStage<Request, Request, ProviderChatResponse<'openaiResponses'>, ProviderChatResponse<'openaiResponses'>, ProviderChatServices>({
  name: 'injectCodexDefaultInstructions',
  through: {
    request: { needs: ['request.provider.payload'], consumes: ['request.provider.payload'], provides: ['request.provider.payload'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => move({
    ...await next(move({ ...facts, 'request.provider.payload': defaultInstructionsPayload(facts['request.provider.payload']) })),
  }),
});
