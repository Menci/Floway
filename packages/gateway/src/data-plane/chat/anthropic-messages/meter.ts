import type { StreamOutcome } from '../../pipeline/serve.ts';
import { meterChatWire } from '../meter.ts';
import { createAnthropicMessagesBillableUsageReader } from './usage.ts';
import type { BillableEntity } from '../../pipeline/facts.ts';
import { tokenUsageFromBillableUsage, tokenUsageMeasurement } from '../../shared/telemetry/usage.ts';
import { isFirstOutputTokenFrame } from '../shared/first-output-token.ts';
import { defer, type Deferred } from '@floway-dev/pipeline';
import { ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE, type AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame, BillableUsage } from '@floway-dev/protocols/common';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

export const meterUsage = (streamedUsage: string) => meterChatWire({
  wire: 'anthropicMessages',
  answer: 'response.chat.anthropicMessages',
  streamedUsage,
  read: meterAnthropicMessages,
});

/** Reads the upstream's own usage off its own events as they pass, so the reading costs one
 *  pass and the client's stream is what drives it. Anthropic states input accounting on
 *  `message_start` and output accounting on `message_delta`, so the reader that merges the
 *  two is per-stream state and is made here rather than shared. */
const meterAnthropicMessages = (
  source: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEvent>>,
  identity: TelemetryModelIdentity,
  attempt: { firstOutputTokenAt: number | null },
): { readonly frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEvent>>; readonly outcome: Deferred<StreamOutcome> } => {
  let settle!: (outcome: StreamOutcome) => void;
  // Declared as this run's own unfinished work, so the runner waits for it at teardown where
  // it can see it rather than the reading being started and forgotten.
  const outcome = defer(new Promise<StreamOutcome>(resolve => { settle = resolve; }));
  // Running out without the terminal frame is what "it did not finish" means, and it is known
  // at the same moment the usage is.
  let sawTerminal = false;
  let failed = false;
  const readBillableUsage = createAnthropicMessagesBillableUsageReader();
  const generator = (async function* () {
    let reported: BillableUsage | undefined;
    try {
      for await (const frame of source) {
        // Time to first token is measured where the token is, which is the only place that
        // knows a frame carries generated content rather than the envelope around it.
        if (attempt.firstOutputTokenAt === null && isFirstOutputTokenFrame(frame, 'anthropicMessages')) {
          attempt.firstOutputTokenAt = performance.now();
        }
        if (frame.type === 'event') {
          const usage = readBillableUsage(frame.event);
          if (usage !== null) reported = usage;
        }
        if (isAnthropicMessagesTerminalFrame(frame)) {
          sawTerminal = true;
          failed = frame.type === 'event' && frame.event.type === 'error';
        }
        yield frame;
        // The turn is over, so there is nothing further to read. An upstream that holds the
        // connection open past `message_stop` would otherwise hold the client's stream open
        // with it; returning here closes the read, which cancels the upstream.
        if (isAnthropicMessagesTerminalFrame(frame)) return;
      }
      // Frames ran out with no terminal event, which is a turn nobody can answer from: the
      // message was never stopped and never failed.
      throw new Error(ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE);
    } finally {
      // Reached however the frames ended — the terminal event, a client that stopped
      // reading, or a broken upstream — because tokens the upstream already metered are
      // billable whatever happened to the downstream half.
      settle({ billable: [billedEntity(reported, identity)], failed: failed || !sawTerminal });
    }
  })();
  return { frames: { [Symbol.asyncIterator]: () => generator }, outcome };
};

/** What ends an Anthropic Messages turn. Anthropic's own stream terminator is an event rather than a
 *  transport sentinel, and a stream that failed mid-turn says so with `error` in place of the
 *  `message_stop` that will now never come. */
const isAnthropicMessagesTerminalFrame = (frame: ProtocolFrame<AnthropicMessagesStreamEvent>): boolean =>
  frame.type === 'event' && (frame.event.type === 'message_stop' || frame.event.type === 'error');

/** What one attempt is billable for. An upstream that reported nothing leaves no quantities
 *  at all, which is a different statement from reporting zero — and a rate can depend on the
 *  service tier and on how much input there was, so both travel as pricing facts rather than
 *  being folded into the quantities. */
const billedEntity = (usage: BillableUsage | undefined, identity: TelemetryModelIdentity): BillableEntity => {
  const tokens = tokenUsageFromBillableUsage(usage);
  if (tokens === null) return { identity, quantities: {} };
  const measurement = tokenUsageMeasurement(tokens);
  return { identity, quantities: measurement.quantities, pricingFacts: measurement.pricingFacts };
};
