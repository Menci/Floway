import { defaultInstructionsPayload } from '../interceptors/openai-responses/inject-default-instructions.ts';
import type { CodexAccountFacts } from '../pipeline-facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProviderChatResponse, ProviderChatServices } from '@floway-dev/provider';

type Request = CodexAccountFacts<'openaiResponses' | 'openaiResponsesCompact'>;

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
