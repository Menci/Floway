import type { AffinityEgressOptions } from '../../shared/affinity/index.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';

interface OpenBlock {
  readonly type: string;
  signatureEvent?: SignatureDeltaEvent;
}

type ContentBlockDeltaEvent = Extract<AnthropicMessagesStreamEventEx, { type: 'content_block_delta' }>;
type SignatureDeltaEvent = ContentBlockDeltaEvent & {
  readonly delta: Extract<ContentBlockDeltaEvent['delta'], { type: 'signature_delta' }>;
};

const isSignatureDeltaEvent = (event: AnthropicMessagesStreamEventEx): event is SignatureDeltaEvent =>
  event.type === 'content_block_delta' && event.delta.type === 'signature_delta';

const wrappedSignatureEvent = async (
  event: SignatureDeltaEvent | undefined,
  index: number,
  options: AffinityEgressOptions,
): Promise<AnthropicMessagesStreamEventEx | null> => {
  if (event === undefined) return null;
  const { index: _index, delta, ...eventExtras } = event;
  const { signature, ...deltaExtras } = delta;
  return {
    ...eventExtras,
    type: 'content_block_delta',
    index,
    delta: {
      ...deltaExtras,
      type: 'signature_delta',
      signature: signature.length === 0
        ? signature
        : await options.codec.wrap(signature, options.affinity, 'anthropic-messages.thinking.signature'),
    },
  };
};

export const wrapAnthropicMessagesAffinityEgress = async function* (
  frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEventEx>> {
  const openBlocks = new Map<number, OpenBlock>();

  const flushOpenSignatures = async function* (): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEventEx>> {
    for (const [index, block] of openBlocks) {
      const signature = await wrappedSignatureEvent(block.signatureEvent, index, options);
      if (signature !== null) yield eventFrame(signature);
    }
    openBlocks.clear();
  };

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }

    const event = frame.event;
    if (event.type === 'content_block_start') {
      const block = event.content_block;
      openBlocks.set(event.index, { type: block.type });
      if (block.type === 'redacted_thinking' && block.data.length > 0) {
        yield eventFrame({
          ...event,
          content_block: {
            ...block,
            data: await options.codec.wrap(block.data, options.affinity, 'anthropic-messages.redacted_thinking.data'),
          },
        });
      } else if (block.type === 'thinking' && block.signature.length > 0) {
        yield eventFrame({
          ...event,
          content_block: {
            ...block,
            signature: await options.codec.wrap(block.signature, options.affinity, 'anthropic-messages.thinking.signature'),
          },
        });
      } else {
        yield frame;
      }
      continue;
    }

    if (isSignatureDeltaEvent(event)) {
      const block = openBlocks.get(event.index);
      if (block?.type === 'thinking') {
        block.signatureEvent = event;
      } else if (event.delta.signature.length === 0) {
        yield frame;
      } else {
        yield eventFrame({
          ...event,
          delta: {
            ...event.delta,
            signature: await options.codec.wrap(event.delta.signature, options.affinity, 'anthropic-messages.thinking.signature'),
          },
        });
      }
      continue;
    }

    if (event.type === 'content_block_stop') {
      const block = openBlocks.get(event.index);
      if (block !== undefined) {
        const signature = await wrappedSignatureEvent(block.signatureEvent, event.index, options);
        if (signature !== null) yield eventFrame(signature);
        openBlocks.delete(event.index);
      }
      yield frame;
      continue;
    }

    if (event.type === 'message_delta' && event.delta.stop_reason != null) {
      yield* flushOpenSignatures();
      yield frame;
      continue;
    }

    if (event.type === 'message_stop') {
      yield* flushOpenSignatures();
      yield frame;
      return;
    }

    yield frame;
    if (event.type === 'error') return;
  }
};
