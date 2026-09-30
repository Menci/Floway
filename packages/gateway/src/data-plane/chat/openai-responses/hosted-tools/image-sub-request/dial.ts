import type { RunDump } from '../../../../../dump/run-sink.ts';
import type { HostedToolLifecycleEvent, HostedToolTerminal } from '../types.ts';
import type { Fields } from './facts.ts';
import type { ImageServices } from './services.ts';
import type { BillableEntity } from '../../../../pipeline/facts.ts';
import type { StreamOutcome } from '../../../../pipeline/serve.ts';
import { defineStage, defer, move } from '@floway-dev/pipeline';
import { eventFrame } from '@floway-dev/protocols/common';

const recordLifecycle = (source: AsyncGenerator<HostedToolLifecycleEvent, HostedToolTerminal>, dump: RunDump | null): AsyncGenerator<HostedToolLifecycleEvent, HostedToolTerminal> => {
  if (dump === null) return source;
  const recording = dump.openStream();
  const generator = (async function* () {
    let completed = false;
    try {
      for (;;) {
        const step = await source.next();
        recording.frame(eventFrame(step.value));
        if (step.done) {
          completed = true;
          recording.end();
          return step.value;
        }
        yield step.value;
      }
    } finally {
      if (!completed) await source.return(undefined as never);
    }
  })();
  return Object.assign(generator, recording.fact);
};

/**
 * The ending. It hands up the lifecycle the caller drives, and the reading that lifecycle
 * settles — the same shape every streaming family hands up, for the same reason: the numbers
 * arrive with the last event.
 */
export const dialImageGeneration = defineStage<
  Fields<'request.imageGeneration.action'>,
  Fields<'response.imageGeneration.lifecycle' | 'response.imageGeneration.streamedUsage'> & { 'response.usage.billable': readonly BillableEntity[] },
  ImageServices
>({
  name: 'dialImageGeneration',
  return: {
    provides: ['response.imageGeneration.lifecycle', 'response.imageGeneration.streamedUsage', 'response.usage.billable'],
  },
  execute: async (facts, use) => {
    let settle!: (outcome: StreamOutcome) => void;
    // Declared as this run's own unfinished work, so the runner waits for it at teardown where
    // it can see it rather than the reading being started and forgotten.
    const outcome = defer(new Promise<StreamOutcome>(resolve => { settle = resolve; }));
    return move({
      ...facts,
      'response.imageGeneration.lifecycle': recordLifecycle(use.imageCall((billable, failed, telemetry) => {
        // The sample is attributed to this run's own attempt slot, which is what keeps the
        // turn that asked for the image from having its upstream stamp overwritten.
        use.gateway.attempt.telemetry = telemetry;
        settle({ billable, failed });
      }), use.gateway.dump),
      'response.imageGeneration.streamedUsage': outcome,
      // Nothing has been reported when this hands up; what the call turns out to have cost
      // arrives through the reading above.
      'response.usage.billable': [],
    }) as never;
  },
});
