// Driving Anthropic's web-search stage from a test that scripts the dial.
//
// What a test scripts is the *ending* — the one answer the stage descends for. Everything above
// it is the real chain: the preparation rewrites the body, the stage descends, and the frames
// come back rewritten into Anthropic's native shape.
//
// `invocation.payload` is written back on the descent, so a test that asserts on what the
// upstream was asked for reads the same field it always did.

import { runAnthropicMessagesWebSearchTool } from '../../../../src/data-plane/chat/anthropic-messages/web-search-tool.ts';
import type { ChatGatewayCtx } from '../../../../src/data-plane/chat/shared/gateway-ctx.ts';
import { compose, defineStage, move, run } from '@floway-dev/pipeline';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { AnthropicMessagesInvocation, ExecuteResult, ModelCandidate } from '@floway-dev/provider';

const ANSWER = 'response.chat.anthropicMessages';

type Result = ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEvent>>;

/** A scripted refusal as the failure value a chain carries. */
const failureOf = (result: Exclude<Result, { type: 'events' }>) => ({
  status: result.type === 'internal-error' ? result.status : result.status,
  message: result.type === 'internal-error' ? result.error.message : new TextDecoder().decode(result.body),
});

/** What the run answered with, in the shape the assertions read. */
const resultOf = (facts: Record<string, unknown>): Result => {
  const answer = facts[ANSWER] as { status?: number; message?: string; body?: unknown; kind?: string; frames?: unknown };
  if (answer.kind === 'stream') {
    return { type: 'events', events: answer.frames as AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEvent>>, modelIdentity: undefined } as unknown as Result;
  }
  return {
    type: 'api-error',
    source: 'gateway',
    status: answer.status!,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: new TextEncoder().encode(answer.message!),
  } as Result;
};

export const driveWebSearchStage = async (
  invocation: AnthropicMessagesInvocation,
  gatewayCtx: ChatGatewayCtx,
  dial: () => Promise<Result>,
): Promise<Result> => {
  const ending = defineStage<Record<string, unknown>, Record<string, unknown>>({
    name: 'scriptedDial',
    return: { provides: [ANSWER, 'response.usage.billable', 'response.http.headers'] },
    execute: async facts => {
      invocation.payload = facts['request.chat.anthropicMessages'] as AnthropicMessagesPayload;
      const result = await dial();
      return move({
        ...facts,
        [ANSWER]: result.type === 'events'
          ? { kind: 'stream' as const, frames: result.events }
          : failureOf(result),
        'response.usage.billable': [],
        'response.http.headers': [],
      });
    },
  });

  const chain = compose<Record<string, unknown>, Record<string, unknown>>('webSearchToolUnderTest', [
    runAnthropicMessagesWebSearchTool({ targetOf: () => invocation.targetApi }) as never,
    ending,
  ]);

  const { facts } = await run(chain, move({
    'request.chat.anthropicMessages': invocation.payload,
    'route.attempt': { upstreamId: 'up_test', modelId: invocation.payload.model, flags: [] },
  }), {
    gateway: gatewayCtx,
    background: () => {},
    resolveAttempt: (): ModelCandidate => invocation.candidate,
  } as never);

  return resultOf(facts);
};
