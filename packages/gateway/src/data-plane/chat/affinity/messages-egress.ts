import type { AffinityEgressOptions } from './affinity-egress.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';

interface OpenBlock {
  readonly type: string;
  signature?: string;
}

export const wrapMessagesAffinityEgress = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
  const openBlocks = new Map<number, OpenBlock>();
  let nextBlockIndex = 0;
  let sawCarrier = false;
  let syntheticEmitted = false;

  const syntheticEvents = async (): Promise<MessagesStreamEvent[]> => {
    if (sawCarrier || syntheticEmitted) return [];
    syntheticEmitted = true;
    const index = nextBlockIndex++;
    return [
      {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'redacted_thinking',
          data: await options.codec.wrap(undefined, options.affinity),
        },
      },
      { type: 'content_block_stop', index },
    ];
  };

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }

    const event = frame.event;
    if (event.type === 'content_block_start') {
      nextBlockIndex = Math.max(nextBlockIndex, event.index + 1);
      if (openBlocks.has(event.index)) throw new Error(`Messages content block ${event.index} started twice`);
      openBlocks.set(event.index, { type: event.content_block.type });
      if (event.content_block.type !== 'redacted_thinking') {
        yield frame;
        continue;
      }

      sawCarrier = true;
      yield eventFrame({
        ...event,
        content_block: {
          ...event.content_block,
          data: await options.codec.wrap(event.content_block.data, options.affinity),
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
      if (block.signature !== undefined) {
        sawCarrier = true;
        yield eventFrame({
          type: 'content_block_delta',
          index: event.index,
          delta: {
            type: 'signature_delta',
            signature: await options.codec.wrap(block.signature, options.affinity),
          },
        });
      }
      openBlocks.delete(event.index);
      yield frame;
      continue;
    }

    if (event.type === 'message_delta' && event.delta.stop_reason != null) {
      if (openBlocks.size > 0) throw new Error('Messages terminal message_delta arrived with an open content block');
      for (const synthetic of await syntheticEvents()) yield eventFrame(synthetic);
      yield frame;
      continue;
    }

    if (event.type === 'message_stop') {
      if (openBlocks.size > 0) throw new Error('Messages message_stop arrived with an open content block');
      for (const synthetic of await syntheticEvents()) yield eventFrame(synthetic);
      yield frame;
      return;
    }

    yield frame;
    if (event.type === 'error') return;
  }
};
