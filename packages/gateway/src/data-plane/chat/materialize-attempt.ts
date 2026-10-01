import type { Chat } from './facts.ts';
import type { ChatServices } from './services.ts';
import type { Slice } from './stage-contracts.ts';
import { defineStage, move } from '@floway-dev/pipeline';

// Select this attempt's affinity projection below the fork. Rules then rewrite that request
// fact, while the resolver's other candidate values remain shared for a later attempt.
export const materializeAttempt = (requestKey: string) => defineStage<
  Slice<'route.attempt'> & Chat<'request.chat.candidatePayloads'>,
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
  ChatServices
>({
  name: `materializeAttempt:${requestKey}`,
  through: {
    request: { needs: ['route.attempt', 'request.chat.candidatePayloads'], consumes: [], provides: [requestKey] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) =>
    await next({ ...facts, [requestKey]: move(facts['request.chat.candidatePayloads'][facts['route.attempt'].candidateId]) }),
});
