// Driving the server-tool stage from a test that scripts the dial.
//
// The stage descends once per upstream turn, so what a test scripts is the *ending* — one
// answer per descent, in the order the loop asks for them. Everything above the ending is the
// real chain: the registrations prepare, the loop splices, and what comes back is read off the
// facts rather than out of a mock.
//
// `invocation.payload` is written back on every descent, so a test that asserts on what the
// upstream was last asked for reads the same field it always did.

import type { ServerToolRegistration } from '../../../../../src/data-plane/chat/openai-responses/server-tools/shim.ts';
import { runOpenAIResponsesServerTools } from '../../../../../src/data-plane/chat/openai-responses/server-tools/stage.ts';
import type { ChatGatewayCtx } from '../../../../../src/data-plane/chat/shared/gateway-ctx.ts';
import type { Failure } from '../../../../../src/data-plane/pipeline/facts.ts';
import { mintedErrorEnvelope, renderFailure } from '../../../../../src/data-plane/pipeline/facts.ts';
import type { StreamOutcome } from '../../../../../src/data-plane/pipeline/serve.ts';
import { tokenUsageFromBillableUsage, tokenUsageMeasurement } from '../../../../../src/data-plane/shared/telemetry/usage.ts';
import { compose, defer, defineStage, move, run, type Deferred } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import type { EventResultMetadata, ExecuteResult, ModelCandidate, OpenAIResponsesInvocation } from '@floway-dev/provider';

const ANSWER = 'response.chat.openaiResponses';
const STREAMED_USAGE = 'response.chat.openaiResponses.streamedUsage';

type Result = ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEvent>>;

/** What a scripted turn will have billed, as the wire's meter would have handed it up: one
 *  entity naming the model that answered, carrying what it reported. A turn that reports
 *  nothing still names its identity, which is how the loop's own reading shows which upstream
 *  each of its calls reached. */
const readingOf = (result: Extract<Result, { type: 'events' }>) => defer(
  (result.finalMetadata ?? Promise.resolve({ modelIdentity: result.modelIdentity, billableUsage: undefined }))
    .then((metadata: EventResultMetadata): StreamOutcome => {
      const tokens = tokenUsageFromBillableUsage(metadata.billableUsage);
      return {
        billable: [{ identity: metadata.modelIdentity, quantities: tokens === null ? {} : tokenUsageMeasurement(tokens).quantities }],
        failed: false,
      };
    }),
);

/** A scripted refusal as the failure value a chain carries. An internal error has no body of
 *  its own, so what travels is the sentence it raised. */
const failureOf = (result: Exclude<Result, { type: 'events' }>) => ({
  status: result.type === 'internal-error' ? 500 : result.status,
  message: result.type === 'internal-error' ? result.error.message : new TextDecoder().decode(result.body),
});

/** What the run answered with, in the shape the assertions read. A refusal is rendered the way
 *  the edge renders one — through the same three tiers — so a test reads the bytes a client
 *  would have been sent rather than a restatement of them. */
const resultOf = (facts: Record<string, unknown>): Result => {
  const answer = facts[ANSWER] as { status?: number; message?: string; kind?: string; frames?: unknown };
  if (answer.kind === 'stream') {
    return { type: 'events', events: answer.frames as AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>, modelIdentity: undefined } as unknown as Result;
  }
  const rendered = renderFailure(answer as Failure, mintedErrorEnvelope);
  return {
    type: 'api-error',
    source: 'gateway',
    status: rendered.status,
    headers: new Headers({ 'content-type': 'application/json' }),
    body: new TextEncoder().encode(JSON.stringify(rendered.body)),
  } as Result;
};

export const driveServerToolStage = (registrations: readonly ServerToolRegistration[]) =>
  async (
    invocation: OpenAIResponsesInvocation,
    gatewayCtx: ChatGatewayCtx,
    dial: () => Promise<Result>,
  ): Promise<Result & { reading: Deferred<StreamOutcome> | null }> => {
    const ending = defineStage<Record<string, unknown>, Record<string, unknown>>({
      name: 'scriptedDial',
      return: { provides: [ANSWER, STREAMED_USAGE, 'response.usage.billable', 'response.http.headers'] },
      execute: async facts => {
        invocation.payload = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;
        const result = await dial();
        const answered = result.type === 'events'
          ? { [ANSWER]: { kind: 'stream' as const, frames: result.events }, [STREAMED_USAGE]: readingOf(result) }
          : { [ANSWER]: failureOf(result), [STREAMED_USAGE]: null };
        return move({
          ...facts,
          ...answered,
          'response.usage.billable': result.type === 'events'
            ? [{ identity: result.modelIdentity, quantities: {} }]
            : [],
          'response.http.headers': [],
        });
      },
    });

    const chain = compose<Record<string, unknown>, Record<string, unknown>>('serverToolsUnderTest', [
      runOpenAIResponsesServerTools(registrations, {
        streamedUsage: STREAMED_USAGE,
        targetOf: () => invocation.targetApi,
      }) as never,
      ending,
    ]);

    const { facts } = await run(chain, move({
      'request.chat.openaiResponses': invocation.payload,
      'route.attempt': { upstreamId: 'up_test', modelId: invocation.payload.model, flags: [] },
      'ingress.http.headers': [...invocation.headers],
    }), {
      gateway: gatewayCtx,
      background: () => {},
      resolveAttempt: (): ModelCandidate => invocation.candidate,
    } as never);

    // The reading the run hands up, which is where every turn's identity and cost land now
    // that a stage observes them.
    return { ...resultOf(facts), reading: facts[STREAMED_USAGE] as Deferred<StreamOutcome> | null };
  };
