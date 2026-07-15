import { MESSAGES_REDACTED_AFFINITY_DOMAIN, MESSAGES_SIGNATURE_AFFINITY_DOMAIN } from './domain.ts';
import type { AffinityEgressOptions } from '../../shared/affinity/egress-options.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';

interface OpenBlock {
  readonly type: string;
  readonly first: boolean;
  readonly syntheticSignature?: Promise<string>;
  signature?: string;
}

export const wrapMessagesAffinityEgress = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
  const openBlocks = new Map<number, OpenBlock>();
  const syntheticPrefix = options.codec.wrap(undefined, options.affinity, MESSAGES_REDACTED_AFFINITY_DOMAIN);
  let firstBlockSeen = false;
  let indexOffset = 0;

  const syntheticEvents = async (): Promise<MessagesStreamEvent[]> => {
    return [
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'redacted_thinking',
          data: await syntheticPrefix,
        },
      },
      { type: 'content_block_stop', index: 0 },
    ];
  };

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }

    const event = frame.event;
    if (event.type === 'content_block_start') {
      if (openBlocks.has(event.index)) throw new Error(`Messages content block ${event.index} started twice`);
      const first = !firstBlockSeen;
      firstBlockSeen = true;
      openBlocks.set(event.index, {
        type: event.content_block.type,
        first,
        ...(first && event.content_block.type === 'thinking'
          ? { syntheticSignature: options.codec.wrap(undefined, options.affinity, MESSAGES_SIGNATURE_AFFINITY_DOMAIN) }
          : {}),
      });

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
          data: await options.codec.wrap(event.content_block.data, options.affinity, MESSAGES_REDACTED_AFFINITY_DOMAIN),
        },
      });
      continue;
    }

    if (event.type === 'content_block_delta' && event.delta.type === 'signature_delta') {
      const block = openBlocks.get(event.index);
      if (block?.type !== 'thinking') throw new Error(`Messages signature_delta targeted non-thinking block ${event.index}`);
      block.signature = event.delta.signature;
      continue;
    }

    if (event.type === 'content_block_stop') {
      const block = openBlocks.get(event.index);
      if (block === undefined) throw new Error(`Messages content block ${event.index} stopped before it started`);
      if (block.signature !== undefined || (block.first && block.type === 'thinking')) {
        if (block.signature === undefined && block.syntheticSignature === undefined) {
          throw new Error('First Messages thinking block has no synthetic signature promise');
        }
        yield eventFrame({
          type: 'content_block_delta',
          index: event.index + indexOffset,
          delta: {
            type: 'signature_delta',
            signature: block.signature === undefined
              ? await block.syntheticSignature
              : await options.codec.wrap(block.signature, options.affinity, MESSAGES_SIGNATURE_AFFINITY_DOMAIN),
          },
        });
      }
      openBlocks.delete(event.index);
      yield eventFrame({ ...event, index: event.index + indexOffset });
      continue;
    }

    if (event.type === 'content_block_delta') {
      yield eventFrame({ ...event, index: event.index + indexOffset });
      continue;
    }

    if (event.type === 'message_delta' && event.delta.stop_reason != null) {
      if (openBlocks.size > 0) throw new Error('Messages terminal message_delta arrived with an open content block');
      if (!firstBlockSeen) for (const synthetic of await syntheticEvents()) yield eventFrame(synthetic);
      yield frame;
      continue;
    }

    if (event.type === 'message_stop') {
      if (openBlocks.size > 0) throw new Error('Messages message_stop arrived with an open content block');
      if (!firstBlockSeen) for (const synthetic of await syntheticEvents()) yield eventFrame(synthetic);
      yield frame;
      return;
    }

    yield frame;
    if (event.type === 'error') return;
  }
};
