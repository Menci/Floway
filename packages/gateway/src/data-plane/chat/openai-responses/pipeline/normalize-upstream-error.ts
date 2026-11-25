import { openAIResponsesExit, openAIResponsesFactSpace } from './facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import { isJsonObject } from '@floway-dev/protocols/common';

const { defineStage } = openAIResponsesFactSpace<{}>();

export const normalizeOpenAIResponsesUpstreamError = defineStage({
  name: 'openaiResponses.normalize-upstream-error',
  through: {
    request: { needs: [], provides: [], consumes: [] },
    response: { needs: openAIResponsesExit, provides: ['response.openaiResponses'], consumes: [] },
  },
  execute: transform(() => ({
    response(facts) {
      const outcome = facts['response.openaiResponses'];
      if (outcome.kind !== 'error' || outcome.source !== 'upstream' || !(outcome.cause instanceof SyntaxError)) return facts;
      const { error } = outcome;
      if (!isJsonObject(error) || error.type !== 'error' || typeof error.message !== 'string') return facts;
      return {
        ...facts,
        'response.openaiResponses': move({
          ...outcome,
          error: {
            error: {
              type: (facts['response.http']?.status ?? 502) >= 500 ? 'server_error' : 'invalid_request_error',
              message: error.message,
            },
          },
        }),
      };
    },
  })),
});
