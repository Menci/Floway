import type { ChatPipelineServices } from '../../../../../src/data-plane/chat/pipeline/index.ts';
import { runChatStage } from '../../../../test-utils/chat-pipeline.ts';
import type { Stage } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ExecuteResult } from '@floway-dev/provider';

export interface ShimInvocation {
  payload: import('@floway-dev/protocols/openai-responses').CanonicalOpenAIResponsesPayload;
  action: 'generate' | 'compact';
  candidate: import('@floway-dev/provider').RouteCandidate;
  targetApi: import('@floway-dev/provider').ChatTargetApi;
  headers: Headers;
}

export type ShimOutcome = ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEventEx>>;

export const runShim = async (
  stage: Stage<any, any, any, any, any, ChatPipelineServices>,
  invocation: ShimInvocation,
  run: (payload: ShimInvocation['payload'], env: Parameters<Parameters<typeof runChatStage>[0]['next']>[1]) => Promise<ShimOutcome>,
): Promise<ShimOutcome> => {
  const { outcome } = await runChatStage({
    stage,
    facts: {
      'route.candidate': invocation.candidate,
      'request.payload': invocation.payload,
      'request.action': invocation.action,
      'route.targetApi': invocation.targetApi,
    },
    next: async (facts, env) => {
      invocation.payload = facts['request.payload'];
      const result = await run(facts['request.payload'], env);
      if (result.type !== 'events') return result as never;
      return {
        ...result,
        events: env.createStream({ async *iterate() { yield* result.events; } }),
        http: result.http === undefined ? undefined : {
          status: result.http.status,
          headers: Object.freeze([...result.http.headers.entries()].map(([name, value]) => Object.freeze([name, value] as const))),
        },
      } as never;
    },
  });
  return outcome as unknown as ShimOutcome;
};
