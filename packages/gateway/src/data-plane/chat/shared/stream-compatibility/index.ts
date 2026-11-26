import type { Result } from '@floway-dev/pipeline';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { FlagId, ProtocolStreamError } from '@floway-dev/provider';

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

const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;
const MAX_BUFFERED_FRAMES = 16_384;
const encoder = new TextEncoder();

interface PendingFrame<Frame> {
  frame: Frame;
  bytes?: number;
}

const serialize = async function* <Frame>(
  frames: AsyncIterable<Frame>,
  describe: (frame: Frame) => ItemEvent | undefined,
  isError: (frame: Frame) => boolean,
  incomplete: () => Frame,
): AsyncGenerator<Frame> {
  let current: number | undefined;
  let retainedBytes = 0;
  let retainedFrames = 0;
  let buffered: Array<PendingFrame<Frame> | undefined> = [];
  for await (const frame of frames) {
    const work: Array<{ frames: Array<PendingFrame<Frame> | undefined>; cursor: number }> = [{ frames: [{ frame }], cursor: 0 }];
    while (work.length > 0) {
      const batch = work.at(-1)!;
      if (batch.cursor === batch.frames.length) {
        work.pop();
        continue;
      }
      const { cursor, frames: slots } = batch;
      const item = slots[cursor]!;
      slots[cursor] = undefined;
      batch.cursor++;
      const next = item.frame;
      if (isError(next)) {
        buffered = [];
        yield next;
        return;
      }
      const event = describe(next);
      if (current !== undefined && ((event !== undefined && event.index !== current) || (event === undefined && buffered.length > 0))) {
        if (item.bytes === undefined) {
          item.bytes = encoder.encode(JSON.stringify(next)).byteLength;
          retainedBytes += item.bytes;
          retainedFrames++;
          if (retainedBytes > MAX_BUFFERED_BYTES || retainedFrames > MAX_BUFFERED_FRAMES) {
            throw new RangeError(`Interleaved stream exceeds ${MAX_BUFFERED_BYTES} buffered bytes or ${MAX_BUFFERED_FRAMES} buffered frames`);
          }
        }
        buffered.push(item);
        continue;
      }
      if (item.bytes !== undefined) {
        retainedBytes -= item.bytes;
        retainedFrames--;
      }
      if (event?.kind === 'start') current = event.index;
      yield next;
      if (event?.kind === 'end') {
        current = undefined;
        if (buffered.length > 0) {
          work.push({ frames: buffered, cursor: 0 });
          buffered = [];
        }
      }
    }
  }
  if (buffered.length > 0) yield incomplete();
};

const incompleteMessage = 'Cannot serialize an interleaved stream whose active item never closed';
type AnthropicItem = Result<AnthropicMessagesStreamEventEx, ProtocolStreamError>;

export const serializeAnthropicMessagesStream = (frames: AsyncIterable<AnthropicItem>, enabled: boolean): AsyncIterable<AnthropicItem> => enabled
  ? serialize(frames, item => {
      if (!item.ok) return undefined;
      const event = item.value;
      if (event.type === 'content_block_start') return { index: event.index, kind: 'start' };
      if (event.type === 'content_block_delta') return { index: event.index, kind: 'delta' };
      if (event.type === 'content_block_stop') return { index: event.index, kind: 'end' };
      return undefined;
    }, item => !item.ok, () => ({ ok: false, error: { kind: 'protocol', cause: new Error(incompleteMessage) } }))
  : frames;

type ResponsesItem = Result<OpenAIResponsesStreamEventEx, ProtocolStreamError>;

export const serializeOpenAIResponsesStream = (frames: AsyncIterable<ResponsesItem>, enabled: boolean): AsyncIterable<ResponsesItem> => {
  if (!enabled) return frames;
  const ordered = serialize<ResponsesItem>(frames, item => {
    if (!item.ok) return undefined;
    const event = item.value;
    if (!('output_index' in event)) return undefined;
    return { index: event.output_index, kind: event.type === 'response.output_item.added' ? 'start' : event.type === 'response.output_item.done' ? 'end' : 'delta' };
  }, item => !item.ok, () => ({ ok: false, error: { kind: 'protocol', cause: new Error(incompleteMessage) } }));
  return (async function* (): AsyncGenerator<ResponsesItem> {
    let sequence = 0;
    for await (const item of ordered) {
      if (!item.ok) {
        yield item;
        return;
      }
      yield item.value.sequence_number === sequence ? item : { ok: true, value: { ...item.value, sequence_number: sequence } };
      sequence++;
    }
  })();
};
