import type { StreamOutcome } from '../../pipeline/serve.ts';
import { meterChatWire } from '../meter.ts';
import { billableUsageFromOpenAIResponsesEvent } from './usage.ts';
import type { BillableEntity } from '../../pipeline/facts.ts';
import { tokenUsageMeasurement, tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import { isFirstOutputTokenFrame } from '../shared/first-output-token.ts';
import { defer, type Deferred } from '@floway-dev/pipeline';
import type { ProtocolFrame, BillableUsage } from '@floway-dev/protocols/common';
import { isOpenAIResponsesTerminalEvent, OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE, type OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

export const meterUsage = (streamedUsage: string) => meterChatWire({
  wire: 'openaiResponses',
  answer: 'response.chat.openaiResponses',
  streamedUsage,
  read: meterOpenAIResponses,
});

/** Reads the upstream's own usage off its own events as they pass, so the reading costs one
 *  pass and the client's stream is what drives it. OpenAI Responses states its counts on the
 *  lifecycle envelopes, and only one carrying real counts replaces the running figure, so an
 *  envelope that states none cannot wipe a good reading. */
const meterOpenAIResponses = (
  source: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>,
  identity: TelemetryModelIdentity,
  attempt: { firstOutputTokenAt: number | null },
): { readonly frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>; readonly outcome: Deferred<StreamOutcome> } => {
  let settle!: (outcome: StreamOutcome) => void;
  // Declared as this run's own unfinished work, so the runner waits for it at teardown where
  // it can see it rather than the reading being started and forgotten.
  const outcome = defer(new Promise<StreamOutcome>(resolve => { settle = resolve; }));
  // Running out without the terminal frame is what "it did not finish" means, and it is known
  // at the same moment the usage is.
  let sawTerminal = false;
  let failed = false;
  const generator = (async function* () {
    let reported: BillableUsage | undefined;
    try {
      for await (const frame of source) {
        // Time to first token is measured where the token is, which is the only place that
        // knows a frame carries generated content rather than the envelope around it.
        if (attempt.firstOutputTokenAt === null && isFirstOutputTokenFrame(frame, 'openaiResponses')) {
          attempt.firstOutputTokenAt = performance.now();
        }
        if (frame.type !== 'event') {
          yield frame;
          continue;
        }
        const usage = billableUsageFromOpenAIResponsesEvent(frame.event);
        if (usage !== null) reported = usage;
        // Read off the frame rather than off having been resumed past it. The stage that
        // stores the turn's items stops reading at the terminal event, so the resumption
        // never comes: what this loop would learn from it is already true when the frame
        // arrives, and the turn ended the way the upstream said it did whether or not
        // anything downstream asked for another.
        if (isOpenAIResponsesTerminalEvent(frame.event)) {
          sawTerminal = true;
          failed = frame.event.type === 'response.failed' || frame.event.type === 'error';
          settle({ billable: [billedOpenAIResponsesEntity(identity, reported)], failed });
        }
        yield frame;
        // The turn is over, so there is nothing further to read. An upstream that holds the
        // connection open past its terminal event would otherwise hold the client's stream
        // open with it; returning here closes the read, which cancels the upstream.
        if (sawTerminal) return;
      }
      // Frames ran out with no terminal event, which is a turn nobody can answer from: the
      // response was never stated complete, incomplete or failed.
      throw new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE);
    } finally {
      // Reached however the frames ended — the terminal event, a client that stopped
      // reading, or a broken upstream — because tokens the upstream already metered are
      // billable whatever happened to the downstream half.
      settle({ billable: [billedOpenAIResponsesEntity(identity, reported)], failed: failed || !sawTerminal });
    }
  })();
  return { frames: { [Symbol.asyncIterator]: () => generator }, outcome };
};

/** An upstream that reported nothing leaves no quantities at all, which is a different
 *  statement from reporting zero.
 *
 *  A reading that did arrive is converted rather than cast: a billed entity is keyed by
 *  billing metric, which is not the shape a protocol reports in. The tier rides along
 *  because on this protocol it is not a quantity but a rate selector — `service_tier` states
 *  the tier the turn was actually served at, and that is the pricing entry it is billed
 *  under. */
export const billedOpenAIResponsesEntity = (identity: TelemetryModelIdentity, usage: BillableUsage | undefined): BillableEntity => {
  if (usage === undefined) return { identity, quantities: {} };
  const measurement = tokenUsageMeasurement(tokenUsageFromBillableUsage(usage));
  return { identity, quantities: measurement.quantities, pricingFacts: measurement.pricingFacts };
};
