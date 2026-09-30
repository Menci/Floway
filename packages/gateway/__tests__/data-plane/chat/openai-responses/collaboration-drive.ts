import { projectOpenAIResponsesCollaboration } from '../../../../src/data-plane/chat/openai-responses/collaboration-shim.ts';
import type { ChatGatewayCtx } from '../../../../src/data-plane/chat/shared/gateway-ctx.ts';
import { compose, defineStage, move, run } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { providerModelOf, type ExecuteResult, type OpenAIResponsesInvocation } from '@floway-dev/provider';

type Result = ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEvent>>;

export const driveCollaborationStage = async (
  invocation: OpenAIResponsesInvocation,
  gateway: ChatGatewayCtx,
  dial: () => Promise<Result>,
): Promise<Result> => {
  let result: Result | undefined;
  const ending = defineStage<Record<string, unknown>, Record<string, unknown>>({
    name: 'scriptedCollaborationDial',
    return: { provides: ['response.chat.openaiResponses'] },
    execute: async facts => {
      invocation.payload = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;
      result = await dial();
      return move({
        ...facts,
        'response.chat.openaiResponses': result.type === 'events'
          ? { kind: 'stream', frames: result.events }
          : { status: result.type === 'internal-error' ? 500 : result.status, message: 'scripted refusal' },
      });
    },
  });
  const { facts, drain } = await run(compose<Record<string, unknown>, Record<string, unknown>>('collaborationUnderTest', [projectOpenAIResponsesCollaboration, ending]), move({
    'request.chat.openaiResponses': invocation.payload,
    'route.attempt': { candidateId: 0, upstreamId: invocation.candidate.provider.upstreamId, modelId: invocation.payload.model, flags: [...providerModelOf(invocation.candidate).enabledFlags] },
  }), { gateway } as never);
  if (result === undefined) throw new Error('Collaboration harness did not dispatch');
  if (result.type !== 'events') { await drain(); return result; }
  const answer = facts['response.chat.openaiResponses'] as { frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> };
  if (answer.frames === result.events) { await drain(); return result; }
  return {
    ...result,
    events: (async function* () {
      try { yield* answer.frames; } finally { await drain(); }
    })(),
  };
};
