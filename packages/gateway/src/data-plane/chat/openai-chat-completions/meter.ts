import type { StreamOutcome } from '../../pipeline/serve.ts';
import { meterChatWire } from '../meter.ts';
import { billableUsageFromOpenAIChatCompletionsEvent } from './usage.ts';
import type { BillableEntity } from '../../pipeline/facts.ts';
import { isFirstOutputTokenFrame } from '../shared/first-output-token.ts';
import { chatUsageMeasurement, type ChatBillableUsage } from '../shared/usage.ts';
import { defer, type Deferred } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { openaiChatCompletionsErrorPayloadMessage, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

export const meterUsage = (streamedUsage: string) => meterChatWire({
  wire: 'openaiChatCompletions',
  answer: 'response.chat.openaiChatCompletions',
  streamedUsage,
  read: meterOpenAIChatCompletions,
});

/** Reads the upstream's own usage off its own events as they pass, so the reading costs one
 *  pass and the client's stream is what drives it. Only a report carrying real counts
 *  replaces the running figure, so a trailing empty usage frame cannot wipe a good one. */
const meterOpenAIChatCompletions = (
  source: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  identity: TelemetryModelIdentity,
  attempt: { firstOutputTokenAt: number | null },
): { readonly frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>; readonly outcome: Deferred<StreamOutcome> } => {
  const completion = Promise.withResolvers<StreamOutcome>();
  const outcome = defer(completion.promise);
  let settled = false;
  // A clean EOF completes Chat Completions even when no [DONE] frame was sent.
  let completed = false;
  let failed = false;
  const generator = (async function* () {
    let reported: ChatBillableUsage | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      try { completion.resolve({ billable: [billedEntity(reported, identity)], failed: failed || !completed }); } catch (error) {
        completion.reject(error);
        throw error;
      }
    };
    try {
      for await (const frame of source) {
        // Time to first token is measured where the token is, which is the only place that
        // knows a frame carries generated content rather than the envelope around it.
        if (attempt.firstOutputTokenAt === null && isFirstOutputTokenFrame(frame, 'openaiChatCompletions')) {
          attempt.firstOutputTokenAt = performance.now();
        }
        if (frame.type === 'event') {
          const usage = billableUsageFromOpenAIChatCompletionsEvent(frame.event);
          if (usage !== null) reported = usage;
        }
        if (isTerminal(frame)) {
          completed = true;
          failed = frame.type === 'event' && 'error' in frame.event;
          finish();
        }
        yield frame;
        // The terminator is written out before the read stops, because it is what the client
        // reads as the end. Stopping here also drops anything an upstream sends after it.
        if (isTerminal(frame)) return;
      }
      completed = true;
    } finally {
      // Reached however the frames ended — the terminal chunk, a client that stopped
      // reading, or a broken upstream — because tokens the upstream already metered are
      // billable whatever happened to the downstream half.
      finish();
    }
  })();
  return { frames: { [Symbol.asyncIterator]: () => generator }, outcome };
};

/** The frame that says this turn is over: the transport's own terminator, or an error the
 *  upstream wrote into the stream instead of finishing it. */
const isTerminal = (frame: ProtocolFrame<OpenAIChatCompletionsStreamEvent>): boolean =>
  frame.type === 'done' || (frame.type === 'event' && openaiChatCompletionsErrorPayloadMessage(frame.event) !== null);

/** What one attempt is billable for. An upstream that reported nothing leaves no quantities
 *  at all, which is a different statement from reporting zero — and a rate can depend on the
 *  service tier and on how much input there was, so both travel as pricing facts rather than
 *  being folded into the quantities. */
const billedEntity = (usage: ChatBillableUsage | undefined, identity: TelemetryModelIdentity): BillableEntity => {
  if (usage === undefined) return { identity, quantities: {} };
  const measurement = chatUsageMeasurement(usage);
  return { identity, quantities: measurement.quantities, pricingFacts: measurement.pricingFacts };
};
