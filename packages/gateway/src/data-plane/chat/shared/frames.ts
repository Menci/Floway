import { isFailure } from '../../pipeline/facts.ts';
import type { ChatAnswer } from '../facts.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';

/** The response half of every rule here that rewrites a stream: a refusal and a collected
 *  body have no frames to rewrite, and telling the three apart is reading a value rather than
 *  dispatching on a declaration. `null` says there was nothing to do, so the caller hands the
 *  record it was given straight on. */
export const answerWithFrames = <Event>(
  answer: ChatAnswer,
  rewrite: (frames: AsyncIterable<ProtocolFrame<Event>>) => AsyncGenerator<ProtocolFrame<Event>>,
): ChatAnswer | null => {
  if (isFailure(answer) || answer.kind !== 'stream') return null;
  const frames = answer.frames as AsyncIterable<ProtocolFrame<Event>>;
  return { kind: 'stream' as const, frames: { [Symbol.asyncIterator]: () => rewrite(frames) } };
};

/** A stream with each event rewritten one for one. The frame comes back by identity when the
 *  rewrite changed nothing, which is the same conditional-write convention the request-side
 *  rules follow — and a transport frame is not an event, so it rides through untouched. */
export const rewritingEvents = async function* <Event>(
  frames: AsyncIterable<ProtocolFrame<Event>>,
  rewrite: (event: Event) => Event,
): AsyncGenerator<ProtocolFrame<Event>> {
  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const event = rewrite(frame.event);
    yield event === frame.event ? frame : eventFrame(event);
  }
};
