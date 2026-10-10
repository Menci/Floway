import type { AffinityEgressOptions } from '../../shared/affinity/index.ts';
import { isOpenAIResponsesCompactShimItem } from '../interceptors/compact-shim.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { type OpenAIResponsesOutputItemEx, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

const canonicalItemType = (itemType: string): string =>
  itemType === 'compaction' || itemType === 'compaction_summary' || itemType === 'context_compaction' ? 'compaction' : itemType;

const carrierDomain = (itemType: string, slot: string): string =>
  `openai-responses.${canonicalItemType(itemType)}.${slot}`;

const opaqueSlots = (item: OpenAIResponsesOutputItemEx): Array<{ key: string; value: string }> => {
  const slots: Array<{ key: string; value: string }> = [];
  const record = item as unknown as Record<string, unknown>;
  if (typeof record.encrypted_content === 'string' && record.encrypted_content.length > 0 && !isOpenAIResponsesCompactShimItem(item)) {
    slots.push({ key: 'encrypted_content', value: record.encrypted_content });
  }
  if (item.type === 'program' && typeof item.fingerprint === 'string' && item.fingerprint.length > 0) {
    slots.push({ key: 'fingerprint', value: item.fingerprint });
  }
  if (item.type === 'agent_message') {
    item.content.forEach((content, index) => {
      if (content.type === 'encrypted_content' && typeof content.encrypted_content === 'string' && content.encrypted_content.length > 0) {
        slots.push({ key: `content.${index}.encrypted_content`, value: content.encrypted_content });
      }
    });
  }
  return slots;
};

const replaceOpaqueSlots = (
  item: OpenAIResponsesOutputItemEx,
  replacements: ReadonlyMap<string, string>,
): OpenAIResponsesOutputItemEx => {
  const topLevel = Object.fromEntries([...replacements].filter(([key]) => !key.startsWith('content.')));
  const content = item.type === 'agent_message'
    ? item.content.map((part, index) => {
        const replacement = replacements.get(`content.${index}.encrypted_content`);
        return replacement === undefined ? part : { ...part, encrypted_content: replacement };
      })
    : undefined;
  return {
    ...item,
    ...topLevel,
    ...(content !== undefined ? { content } : {}),
  } as OpenAIResponsesOutputItemEx;
};

export const wrapOpenAIResponsesAffinityEgress = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  const wrapped = new Map<string, Promise<string>>();

  const wrapItem = async (item: OpenAIResponsesOutputItemEx, outputIndex: number): Promise<OpenAIResponsesOutputItemEx> => {
    const replacements = new Map<string, string>();
    await Promise.all(opaqueSlots(item).map(async slot => {
      const cacheKey = `${outputIndex}\0${slot.key}\0${slot.value}`;
      let replacement = wrapped.get(cacheKey);
      if (replacement === undefined) {
        replacement = options.codec.wrap(slot.value, options.affinity, carrierDomain(item.type, slot.key));
        wrapped.set(cacheKey, replacement);
      }
      replacements.set(slot.key, await replacement);
    }));
    return replacements.size === 0 ? item : replaceOpaqueSlots(item, replacements);
  };

  const wrapResult = async (response: OpenAIResponsesResultEx): Promise<OpenAIResponsesResultEx> => ({
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
    if (
      event.type === 'response.queued'
      || event.type === 'response.created'
      || event.type === 'response.in_progress'
      || event.type === 'response.completed'
      || event.type === 'response.incomplete'
      || event.type === 'response.failed'
    ) {
      yield eventFrame({ ...event, response: await wrapResult(event.response) });
      if (event.type === 'response.completed' || event.type === 'response.incomplete' || event.type === 'response.failed') return;
      continue;
    }
    yield frame;
    if (event.type === 'error') return;
  }
};
