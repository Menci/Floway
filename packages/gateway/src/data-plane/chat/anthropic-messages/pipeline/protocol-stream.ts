import { readProtocolFrames } from '../../pipeline/protocol-frames.ts';
import type { Result } from '@floway-dev/pipeline';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ProtocolStreamError } from '@floway-dev/provider';

type Frame = ProtocolFrame<AnthropicMessagesStreamEventEx>;
type Item = Result<AnthropicMessagesStreamEventEx, ProtocolStreamError>;

export const transformAnthropicMessagesFrames = async function* (
  items: AsyncIterable<Item>,
  transform: (frames: AsyncIterable<Frame>) => AsyncIterable<Frame>,
  abort: () => void,
): AsyncGenerator<Item> {
  const source = readProtocolFrames(items);
  let failure: ProtocolStreamError | undefined;
  try {
    for await (const frame of transform(source.frames())) {
      if (frame.type === 'done') break;
      yield { ok: true, value: frame.event };
    }
    failure = source.failure;
  } catch (cause) {
    failure = source.failure !== undefined && source.failure === cause ? source.failure : { kind: 'protocol', cause };
  }
  if (!source.done) abort();
  if (failure !== undefined) yield { ok: false, error: failure };
  await source.drain();
};
