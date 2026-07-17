import type { AffinityEgressOptions } from '../../shared/affinity/index.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';

interface OpenBlock {
  readonly type: string;
  readonly first: boolean;
  signatureEvent?: SignatureDeltaEvent;
}

type ContentBlockDeltaEvent = Extract<MessagesStreamEvent, { type: 'content_block_delta' }>;
type SignatureDeltaEvent = ContentBlockDeltaEvent & {
  readonly delta: Extract<ContentBlockDeltaEvent['delta'], { type: 'signature_delta' }>;
};

const isSignatureDeltaEvent = (event: MessagesStreamEvent): event is SignatureDeltaEvent =>
  event.type === 'content_block_delta' && event.delta.type === 'signature_delta';

export const wrapMessagesAffinityEgress = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
  // Messages exposes real block boundaries. A first block that cannot carry a
  // signature is shifted behind one redacted prefix; thinking stays visible
  // while only its latest signature waits for content_block_stop.
  const openBlocks = new Map<number, OpenBlock>();
  let syntheticPrefixEmitted = false;
  let firstBlockSeen = false;
  let indexOffset = 0;

  const syntheticEvents = async (): Promise<MessagesStreamEvent[]> => {
    if (syntheticPrefixEmitted) return [];
    syntheticPrefixEmitted = true;
    return [
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'redacted_thinking',
          data: await options.codec.wrap(undefined, options.affinity, 'messages.redacted_thinking.data'),
        },
      },
      { type: 'content_block_stop', index: 0 },
    ];
  };

  const wrappedSignatureEvent = async (
    index: number,
    block: OpenBlock,
  ): Promise<MessagesStreamEvent | null> => {
    if (block.signatureEvent === undefined && (!block.first || block.type !== 'thinking')) return null;
    if (block.signatureEvent === undefined) {
      return {
        type: 'content_block_delta',
        index: index + indexOffset,
        delta: {
          type: 'signature_delta',
          signature: await options.codec.wrap(undefined, options.affinity, 'messages.thinking.signature'),
        },
      };
    }
    const { index: _index, delta, ...eventExtras } = block.signatureEvent;
    const { signature, ...deltaExtras } = delta;
    return {
      ...eventExtras,
      type: 'content_block_delta',
      index: index + indexOffset,
      delta: {
        ...deltaExtras,
        type: 'signature_delta',
        signature: await options.codec.wrap(signature, options.affinity, 'messages.thinking.signature'),
      },
    };
  };

  const flushOpenSignatures = async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
    for (const [index, block] of openBlocks) {
      const signature = await wrappedSignatureEvent(index, block);
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
      const first = !firstBlockSeen;
      firstBlockSeen = true;
      openBlocks.set(event.index, { type: event.content_block.type, first });

      if (first && event.content_block.type !== 'thinking' && event.content_block.type !== 'redacted_thinking') {
        for (const synthetic of await syntheticEvents()) yield eventFrame(synthetic);
        indexOffset = 1;
      }

      const index = event.index + indexOffset;
      if (event.content_block.type !== 'redacted_thinking') {
        yield eventFrame({ ...event, index });
        continue;
      }

      yield eventFrame({
        ...event,
        index,
        content_block: {
          ...event.content_block,
          data: await options.codec.wrap(event.content_block.data, options.affinity, 'messages.redacted_thinking.data'),
        },
      });
      continue;
    }

    if (isSignatureDeltaEvent(event)) {
      const block = openBlocks.get(event.index);
      if (block?.type === 'thinking') {
        block.signatureEvent = event;
      } else {
        yield eventFrame({
          ...event,
          index: event.index + indexOffset,
          delta: {
            ...event.delta,
            signature: await options.codec.wrap(event.delta.signature, options.affinity, 'messages.thinking.signature'),
          },
        });
      }
      continue;
    }

    if (event.type === 'content_block_stop') {
      const block = openBlocks.get(event.index);
      if (block !== undefined) {
        const signature = await wrappedSignatureEvent(event.index, block);
        if (signature !== null) yield eventFrame(signature);
        openBlocks.delete(event.index);
      }
      yield eventFrame({ ...event, index: event.index + indexOffset });
      continue;
    }

    if (event.type === 'content_block_delta') {
      yield eventFrame({ ...event, index: event.index + indexOffset });
      continue;
    }

    if (event.type === 'message_delta' && event.delta.stop_reason != null) {
      yield* flushOpenSignatures();
      if (!firstBlockSeen) for (const synthetic of await syntheticEvents()) yield eventFrame(synthetic);
      yield frame;
      continue;
    }

    if (event.type === 'message_stop') {
      yield* flushOpenSignatures();
      if (!firstBlockSeen) for (const synthetic of await syntheticEvents()) yield eventFrame(synthetic);
      yield frame;
      return;
    }

    yield frame;
    if (event.type === 'error') return;
  }
};
