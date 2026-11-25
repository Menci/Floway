import { transformProtocolFrames } from '../../pipeline/protocol-frames.ts';
import type { Result } from '@floway-dev/pipeline';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ParsedProtocolFrame, ProtocolFrame } from '@floway-dev/protocols/common';
import type { ProtocolStreamError } from '@floway-dev/provider';

type Frame = ProtocolFrame<AnthropicMessagesStreamEventEx>;
type Item = Result<AnthropicMessagesStreamEventEx, ProtocolStreamError>;

export const transformAnthropicMessagesFrames = (
  items: AsyncIterable<Item>,
  transform: (frames: AsyncIterable<Frame>) => AsyncIterable<ParsedProtocolFrame<AnthropicMessagesStreamEventEx>>,
  abort: () => void,
): AsyncGenerator<Item> => transformProtocolFrames(items, transform, abort);
