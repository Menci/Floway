// The meter, as a wire's outermost stage.
//
// A wire's rules rewrite the answer on the way up: a usage block gets moved onto the carrier
// chunk the spec puts it on, cache buckets an upstream reports alongside the input count get
// folded back into it, and a vendor's own spelling of both becomes OpenAI's. What the client
// reads is the result of all of that.
//
// So that is what the row must be written from. Reading the upstream's raw frames instead
// bills one number and shows another for the same turn, and the two disagree exactly where a
// normalizer had something to say — which is every upstream that needs one. Placing the meter
// **above** the rules rather than at the dial is what makes the two readings the same reading:
// the frames reach it having been through every rewrite, so there is no seam below it left
// where a figure could be taken early.
//
// It is also why the dial no longer names the streamed-usage key at all. A stage cannot report
// a figure it has no means to produce, and stopping the dial from producing one is what keeps
// the class from coming back the next time a rule is added.

import type { ChatAnswer, ChatFacts } from './facts.ts';
import type { ChatServices } from './stages.ts';
import type { BillableEntity } from '../pipeline/facts.ts';
import { isFailure } from '../pipeline/facts.ts';
import type { StreamOutcome } from '../pipeline/serve.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

type ResponseKey = Extract<keyof ChatFacts, `response.chat.${string}`>;

/** What one protocol contributes: reading its own events. Everything else about metering —
 *  where the reading is taken, which identity it is attributed to, what a run that never
 *  streamed reports — is the same for all of them and lives here. */
export type ChatMeterReading<Event> = (
  frames: AsyncIterable<ProtocolFrame<Event>>,
  identity: TelemetryModelIdentity,
  attempt: { firstOutputTokenAt: number | null },
) => { readonly frames: AsyncIterable<ProtocolFrame<Event>>; readonly outcome: Promise<StreamOutcome> };

/** Which identity the figure is attributed to, read off the entity the dial recorded when it
 *  called an upstream. That entity is already the statement "this attempt bills to this
 *  identity, and nothing has been reported for it yet" — so the meter fills in what it turned
 *  out to be billable for rather than deriving a second identity of its own.
 *
 *  A wire that hands up a stream has been dialled, so there is exactly one. Anything else is
 *  this gateway contradicting itself, and it says so rather than billing to a guess. */
const attributedTo = (billable: readonly BillableEntity[], wire: string): TelemetryModelIdentity => {
  if (billable.length !== 1) {
    throw new Error(`${wire} handed up a stream billable to ${billable.length} entities, and a metered stream bills to the one that was dialled`);
  }
  return billable[0].identity;
};

/**
 * Meters whatever the wire below hands up.
 *
 * A refusal and a collected body have no frames to read, and both are ordinary: the reading is
 * `null`, which is how a family says settlement has nothing left to wait for and should write
 * the row now.
 */
export const meterChatWire = <Event>(spec: {
  /** The wire this meters, which names the stage — so a dump says which protocol's events the
   *  reading was taken off without the name being written twice. */
  readonly wire: string;
  /** The answer this wire hands up, whose frames carry the upstream's own usage. */
  readonly answer: ResponseKey;
  /** Where the reading lands. It is the *source* family's key rather than this protocol's,
   *  which is why the wire is told it rather than naming one. */
  readonly streamedUsage: string;
  readonly read: ChatMeterReading<Event>;
}) => defineStage<
  Record<string, never>,
  Record<string, never>,
  { [K in ResponseKey]?: ChatAnswer } & { 'response.usage.billable': readonly BillableEntity[] } & Record<string, unknown>,
  { [K in ResponseKey]?: ChatAnswer } & Record<string, unknown>,
  ChatServices
>({
  name: `meter:${spec.wire}`,
  through: {
    // Nothing on the way down. A meter is a reader of what came back, and naming a request key
    // here would put it in the entry contract of every chain that dials this wire.
    request: { needs: [], consumes: [], provides: [] },
    response: {
      needs: [spec.answer, 'response.usage.billable'],
      consumes: [],
      provides: [spec.answer, spec.streamedUsage],
    },
  },
  execute: async (facts, next, use) => {
    const back = await next(facts);
    const answer = back[spec.answer] as ChatAnswer;
    if (isFailure(answer) || answer.kind !== 'stream') {
      return move({ ...back, [spec.streamedUsage]: null }) as never;
    }

    const metered = spec.read(
      answer.frames as AsyncIterable<ProtocolFrame<Event>>,
      attributedTo(back['response.usage.billable'], spec.wire),
      use.gateway.attempt,
    );
    return move({
      ...back,
      [spec.answer]: { kind: 'stream' as const, frames: metered.frames },
      [spec.streamedUsage]: metered.outcome,
    }) as never;
  },
});
