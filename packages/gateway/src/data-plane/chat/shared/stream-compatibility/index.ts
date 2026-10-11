import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { FlagId } from '@floway-dev/provider';

export const shouldSerializeStreamItems = (flags: ReadonlySet<FlagId>, protocol: 'anthropicMessages' | 'openaiResponses', userAgent: string | null): boolean => {
  if (flags.has('serialize-stream-items')) return true;
  if (protocol !== 'anthropicMessages' || userAgent === null) return false;
  // These versions keep convenience-event state on the latest block, rather than the delta's owner.
  // https://github.com/vercel/ai/blob/2136151c3c249b86191bbbb7e7655d23df8947a2/packages/anthropic/src/anthropic-language-model.ts#L2732-L2747
  // https://github.com/vercel/ai/blob/2136151c3c249b86191bbbb7e7655d23df8947a2/packages/anthropic/src/anthropic-provider.ts#L161-L168
  // https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/lib/MessageStream.ts#L459-L509
  // https://github.com/anthropics/anthropic-sdk-typescript/blob/d49bdab458000bcdffe77bd84b03293f31824fb3/src/client.ts#L978-L980
  return /(?:^|\s)ai-sdk-anthropic\/4\.0\.71(?:\s|$)/.test(userAgent) || /(?:^|\s)Anthropic\/JS 0\.131\.0(?:\s|$)/.test(userAgent);
};

interface ItemEvent { index: number; kind: 'start' | 'delta' | 'end' }

const serialize = async function* <T>(
  frames: AsyncIterable<ProtocolFrame<T>>,
  describe: (event: T) => ItemEvent | undefined,
  isError: (event: T) => boolean,
): AsyncGenerator<ProtocolFrame<T>> {
  let current: number | undefined;
  let buffered: ProtocolFrame<T>[] = [];
  for await (const frame of frames) {
    const work = [{ frames: [frame], cursor: 0 }];
    while (work.length > 0) {
      const batch = work.at(-1)!;
      if (batch.cursor === batch.frames.length) {
        work.pop();
        continue;
      }
      const next = batch.frames[batch.cursor++];
      if (next.type === 'event' && isError(next.event)) {
        buffered = [];
        yield next;
        return;
      }
      const item = next.type === 'event' ? describe(next.event) : undefined;
      if (current !== undefined && ((item !== undefined && item.index !== current) || (item === undefined && buffered.length > 0))) {
        buffered.push(next);
        continue;
      }
      if (item?.kind === 'start') current = item.index;
      yield next;
      if (item?.kind === 'end') {
        current = undefined;
        if (buffered.length > 0) {
          work.push({ frames: buffered, cursor: 0 });
          buffered = [];
        }
      }
    }
  }
  if (buffered.length > 0) throw new Error('Cannot serialize an interleaved stream whose active item never closed');
};

export const serializeAnthropicMessagesStream = (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>, enabled: boolean): AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>> => enabled
  ? serialize(frames, event => {
      if (event.type === 'content_block_start') return { index: event.index, kind: 'start' };
      if (event.type === 'content_block_delta') return { index: event.index, kind: 'delta' };
      if (event.type === 'content_block_stop') return { index: event.index, kind: 'end' };
      return undefined;
    }, event => event.type === 'error')
  : frames;

export const serializeOpenAIResponsesStream = (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>, enabled: boolean): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> => {
  if (!enabled) return frames;
  const ordered = serialize(frames, event => {
    if (!('output_index' in event)) return undefined;
    return { index: event.output_index, kind: event.type === 'response.output_item.added' ? 'start' : event.type === 'response.output_item.done' ? 'end' : 'delta' };
  }, event => event.type === 'error' || event.type === 'response.failed');
  return (async function* () {
    let sequence = 0;
    for await (const frame of ordered) {
      if (frame.type === 'done') yield frame;
      else {
        yield frame.event.sequence_number === sequence ? frame : eventFrame({ ...frame.event, sequence_number: sequence });
        sequence++;
      }
    }
  })();
};
