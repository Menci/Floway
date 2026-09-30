import { recordStream, streamReferenceOf, type RunDump } from '../../../dump/run-sink.ts';
import type { StreamOutcome } from '../../pipeline/serve.ts';
import { defer, type Deferred } from '@floway-dev/pipeline';
import type { ProtocolFrame, SseFrame } from '@floway-dev/protocols/common';

export const framedClientStream = <Frame extends ProtocolFrame<unknown>>(
  source: AsyncIterable<Frame>,
  render: (frame: Frame) => SseFrame,
  errorFrames: (error: unknown) => readonly Frame[],
  dump: RunDump | null,
): {
  readonly frames: AsyncIterable<Frame>;
  readonly rendered: AsyncIterable<SseFrame>;
  readonly failed: Promise<boolean>;
  readonly release: () => Promise<void>;
} => {
  let settle!: (failed: boolean) => void;
  const failed = new Promise<boolean>(resolve => { settle = resolve; });
  let started = false;
  const generator = (async function* () {
    started = true;
    let failed = false;
    try {
      for await (const frame of source) yield { frame, wire: render(frame) };
    } catch (error) {
      failed = true;
      dump?.failed(error);
      for (const frame of errorFrames(error)) yield { frame, wire: render(frame) };
    } finally {
      settle(failed);
    }
  })();
  // A protocol frame is published only after it has a valid transport representation.
  // The pair keeps serialization errors inside completion without formatting a second time.
  const packets = recordStream({ [Symbol.asyncIterator]: () => generator }, dump, packet => packet.frame);
  const reference = streamReferenceOf(packets);
  return {
    frames: { ...reference, [Symbol.asyncIterator]: () => (async function* () { for await (const packet of packets) yield packet.frame; })() },
    rendered: { ...reference, [Symbol.asyncIterator]: () => (async function* () { for await (const packet of packets) yield packet.wire; })() },
    failed,
    release: async () => {
      if (!started) settle(false);
      await generator.return();
    },
  };
};

export const withClientVerdict = (reading: Deferred<StreamOutcome> | null, failed: Promise<boolean>): Deferred<StreamOutcome> | null =>
  reading === null ? null : defer(Promise.all([reading, failed]).then(([outcome, clientFailed]) => ({ ...outcome, failed: outcome.failed || clientFailed })));
