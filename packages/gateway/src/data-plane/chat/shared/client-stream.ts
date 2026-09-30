import { recordStream, streamReferenceOf, type RunDump } from '../../../dump/run-sink.ts';
import type { StreamOutcome } from '../../pipeline/serve.ts';
import { defer, setRelease, type Owned, type Deferred } from '@floway-dev/pipeline';
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
    let completed = false;
    try {
      for await (const frame of source) yield { frame, wire: render(frame) };
      completed = true;
    } catch (error) {
      failed = true;
      dump?.failed(error);
      for (const frame of errorFrames(error)) yield { frame, wire: render(frame) };
    } finally {
      settle(failed || !completed);
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
      if (!started) settle(true);
      await generator.return();
    },
  };
};

export const withClientVerdict = (reading: Deferred<StreamOutcome> | null, failed: Promise<boolean>): Deferred<StreamOutcome> | null =>
  reading === null ? null : defer(Promise.all([reading, failed]).then(([outcome, clientFailed]) => ({ ...outcome, failed: outcome.failed || clientFailed })));

export const bindClientRelease = (facts: object, release: () => Promise<void>): void => {
  if (!('response.http.body' in facts) || facts['response.http.body'] === null) return;
  const body = facts['response.http.body'] as ReadableStream<Uint8Array> & Owned;
  const drain = setRelease(body, async () => {
    try { await drain(); } finally { await release(); }
  });
};
