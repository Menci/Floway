import type { AffinityEgressOptions } from './affinity-egress.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesOutputItem, ResponsesOutputReasoning, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const randomReasoningId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `rs_affinity_${hex}`;
};

const encryptedContentSlots = (item: ResponsesOutputItem): Array<{ key: string; value: string }> => {
  const slots: Array<{ key: string; value: string }> = [];
  const record = item as unknown as Record<string, unknown>;
  if (typeof record.encrypted_content === 'string') {
    slots.push({ key: 'encrypted_content', value: record.encrypted_content });
  }
  if (Array.isArray(record.content)) {
    record.content.forEach((part, index) => {
      if (!part || typeof part !== 'object') return;
      const content = part as Record<string, unknown>;
      if (content.type === 'encrypted_content' && typeof content.encrypted_content === 'string') {
        slots.push({ key: `content.${index}.encrypted_content`, value: content.encrypted_content });
      }
    });
  }
  return slots;
};

const replaceEncryptedContent = (
  item: ResponsesOutputItem,
  replacements: ReadonlyMap<string, string>,
): ResponsesOutputItem => {
  const record = item as unknown as Record<string, unknown>;
  const topLevel = replacements.get('encrypted_content');
  const content = Array.isArray(record.content)
    ? record.content.map((part, index) => {
        const replacement = replacements.get(`content.${index}.encrypted_content`);
        return replacement === undefined || !part || typeof part !== 'object'
          ? part
          : { ...(part as Record<string, unknown>), encrypted_content: replacement };
      })
    : undefined;
  return {
    ...item,
    ...(topLevel !== undefined ? { encrypted_content: topLevel } : {}),
    ...(content !== undefined ? { content } : {}),
  } as ResponsesOutputItem;
};

export const wrapResponsesAffinityEgress = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const wrapped = new Map<string, Promise<string>>();
  let sawCarrier = false;

  const wrapItem = async (item: ResponsesOutputItem, outputIndex: number): Promise<ResponsesOutputItem> => {
    const slots = encryptedContentSlots(item);
    if (slots.length === 0) return item;
    sawCarrier = true;
    const replacements = new Map<string, string>();
    await Promise.all(slots.map(async slot => {
      const cacheKey = `${outputIndex}\0${slot.key}\0${slot.value}`;
      let replacement = wrapped.get(cacheKey);
      if (replacement === undefined) {
        replacement = options.codec.wrap(slot.value, options.affinity);
        wrapped.set(cacheKey, replacement);
      }
      replacements.set(slot.key, await replacement);
    }));
    return replaceEncryptedContent(item, replacements);
  };

  const wrapResult = async (response: ResponsesResult): Promise<ResponsesResult> => ({
    ...response,
    output: await Promise.all(response.output.map(async (item, index) => await wrapItem(item, index))),
  });

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }

    const event = frame.event;
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      yield eventFrame({ ...event, item: await wrapItem(event.item, event.output_index) });
      continue;
    }

    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const response = await wrapResult(event.response);
      if (sawCarrier) {
        yield eventFrame({ ...event, response });
        return;
      }

      const outputIndex = response.output.length;
      const item: ResponsesOutputReasoning = {
        type: 'reasoning',
        id: randomReasoningId(),
        summary: [],
        encrypted_content: await options.codec.wrap(undefined, options.affinity),
      };
      yield eventFrame({ type: 'response.output_item.added', output_index: outputIndex, item });
      yield eventFrame({ type: 'response.output_item.done', output_index: outputIndex, item });
      yield eventFrame({ ...event, response: { ...response, output: [...response.output, item] } });
      return;
    }

    if (event.type === 'response.failed') {
      yield eventFrame({ ...event, response: await wrapResult(event.response) });
      return;
    }

    yield frame;
    if (event.type === 'error') return;
  }
};
