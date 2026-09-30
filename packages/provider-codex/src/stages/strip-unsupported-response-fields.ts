import { supportedResponsesPayload } from '../interceptors/openai-responses/strip-unsupported-fields.ts';
import type { CodexAccountFacts } from '../pipeline-facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProviderChatResponse, ProviderChatServices } from '@floway-dev/provider';

type Request = CodexAccountFacts<'openaiResponses' | 'openaiResponsesCompact'>;

export const stripCodexUnsupportedFields = defineStage<Request, Request, ProviderChatResponse<'openaiResponses'>, ProviderChatResponse<'openaiResponses'>, ProviderChatServices>({
  name: 'stripCodexUnsupportedFields',
  through: {
    request: { needs: ['request.provider.payload'], consumes: ['request.provider.payload'], provides: ['request.provider.payload'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => move({
    ...await next(move({ ...facts, 'request.provider.payload': supportedResponsesPayload(facts['request.provider.payload']) })),
  }),
});
