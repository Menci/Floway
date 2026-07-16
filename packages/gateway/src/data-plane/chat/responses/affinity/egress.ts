import type { AffinityEgressOptions } from '../../shared/affinity/egress-options.ts';
import type { AffinityTarget } from '../../shared/affinity/types.ts';
import { createTemporaryResponsesItemId } from '../items/format.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesOutputItem, ResponsesOutputReasoning, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const carrierDomain = (itemType: string, slot: string): string => `responses.${itemType}.${slot}`;

const itemAffinity = (base: AffinityTarget, item: ResponsesOutputItem): AffinityTarget => ({
  ...base,
  ...('id' in item && typeof item.id === 'string' ? { upstreamItemId: item.id } : {}),
});

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

const wrapNaturalResponsesAffinity = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const wrapped = new Map<string, Promise<string>>();

  const wrapItem = async (item: ResponsesOutputItem, outputIndex: number): Promise<ResponsesOutputItem> => {
    const slots = encryptedContentSlots(item);
    if (slots.length === 0) return item;
    const target = itemAffinity(options.affinity, item);
    const itemId = 'id' in item && typeof item.id === 'string' ? item.id : '';
    const replacements = new Map<string, string>();
    await Promise.all(slots.map(async slot => {
      const cacheKey = `${outputIndex}\0${itemId}\0${slot.key}\0${slot.value}`;
      let replacement = wrapped.get(cacheKey);
      if (replacement === undefined) {
        replacement = options.codec.wrap(slot.value, target, carrierDomain(item.type, slot.key));
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
    if (
      event.type === 'response.created'
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

const canCarryAffinity = (item: ResponsesOutputItem): boolean =>
  item.type === 'reasoning'
  || item.type === 'compaction'
  || item.type === 'context_compaction'
  || item.type === 'agent_message';

const addSequenceOffset = <T extends ResponsesStreamEvent>(event: T, offset: number): T =>
  event.sequence_number === undefined ? event : { ...event, sequence_number: event.sequence_number + offset };

const addOutputIndexOffset = <T extends ResponsesStreamEvent>(event: T, offset: number): T =>
  offset === 0 || !('output_index' in event)
    ? event
    : { ...event, output_index: event.output_index + offset } as T;

const ensureFirstResponsesItemAffinity = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  // Natural opaque fields are wrapped independently above. This outer state
  // machine gives output index zero a carrier: augment a carrier-capable item
  // at close, or insert a complete reasoning prefix and shift every later
  // output/sequence index plus terminal snapshot by the same fixed offsets.
  let syntheticPrefixContent: Promise<string> | undefined;
  const syntheticOnFirstItem = new Map<string, Promise<string>>();
  let firstItem: { readonly outputIndex: number; readonly canCarry: boolean } | undefined;
  let prefixItem: ResponsesOutputReasoning | undefined;
  let outputIndexOffset = 0;
  let sequenceOffset = 0;

  const getPrefixItem = async (): Promise<ResponsesOutputReasoning> => {
    if (prefixItem !== undefined) return prefixItem;
    syntheticPrefixContent ??= options.codec.wrap(
      undefined,
      { ...options.affinity, syntheticItem: true },
      carrierDomain('reasoning', 'encrypted_content'),
    );
    prefixItem = {
      type: 'reasoning',
      id: createTemporaryResponsesItemId('reasoning'),
      summary: [],
      encrypted_content: await syntheticPrefixContent,
    };
    return prefixItem;
  };

  const prefixFrames = async (sequenceNumber: number | undefined): Promise<ResponsesStreamEvent[]> => {
    const item = await getPrefixItem();
    return [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item,
        ...(sequenceNumber !== undefined ? { sequence_number: sequenceNumber } : {}),
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item,
        ...(sequenceNumber !== undefined ? { sequence_number: sequenceNumber + 1 } : {}),
      },
    ];
  };

  const ensureItemCarrier = async (item: ResponsesOutputItem, outputIndex: number): Promise<ResponsesOutputItem> => {
    if (encryptedContentSlots(item).length > 0) return item;
    if (!canCarryAffinity(item)) throw new Error(`Responses item type ${item.type} cannot carry affinity`);
    const target = itemAffinity(options.affinity, item);
    const itemId = 'id' in item && typeof item.id === 'string' ? item.id : '';
    if (item.type === 'agent_message') {
      const slot = `content.${item.content.length}.encrypted_content`;
      const cacheKey = `${outputIndex}\0${itemId}\0${slot}`;
      let encrypted = syntheticOnFirstItem.get(cacheKey);
      if (encrypted === undefined) {
        encrypted = options.codec.wrap(undefined, target, carrierDomain(item.type, slot));
        syntheticOnFirstItem.set(cacheKey, encrypted);
      }
      return { ...item, content: [...item.content, { type: 'encrypted_content', encrypted_content: await encrypted }] };
    }

    const cacheKey = `${outputIndex}\0${itemId}\0encrypted_content`;
    let encrypted = syntheticOnFirstItem.get(cacheKey);
    if (encrypted === undefined) {
      encrypted = options.codec.wrap(undefined, target, carrierDomain(item.type, 'encrypted_content'));
      syntheticOnFirstItem.set(cacheKey, encrypted);
    }
    return { ...item, encrypted_content: await encrypted } as ResponsesOutputItem;
  };

  const rewriteResponse = async (response: ResponsesResult): Promise<ResponsesResult> => {
    let output = response.output;
    if (firstItem?.canCarry && output[firstItem.outputIndex] !== undefined) {
      const firstItemIndex = firstItem.outputIndex;
      const first = await ensureItemCarrier(output[firstItemIndex], firstItemIndex);
      output = output.map((item, index) => index === firstItemIndex ? first : item);
    }
    if (prefixItem !== undefined) output = [prefixItem, ...output];
    return { ...response, output };
  };

  const shifted = (event: ResponsesStreamEvent): ResponsesStreamEvent =>
    addSequenceOffset(addOutputIndexOffset(event, outputIndexOffset), sequenceOffset);

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }

    const event = frame.event;
    if (event.type === 'response.output_item.added' && firstItem === undefined) {
      firstItem = { outputIndex: event.output_index, canCarry: canCarryAffinity(event.item) };
      if (!firstItem.canCarry) {
        for (const prefix of await prefixFrames(event.sequence_number)) yield eventFrame(prefix);
        outputIndexOffset = 1;
        sequenceOffset = 2;
      }
      yield eventFrame(shifted(event));
      continue;
    }

    if (
      event.type === 'response.output_item.done'
      && firstItem?.canCarry
      && event.output_index === firstItem.outputIndex
    ) {
      yield eventFrame(shifted({ ...event, item: await ensureItemCarrier(event.item, event.output_index) }));
      continue;
    }

    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      if (firstItem === undefined) {
        const first = event.response.output[0];
        if (first !== undefined && canCarryAffinity(first)) {
          firstItem = { outputIndex: 0, canCarry: true };
        } else {
          for (const prefix of await prefixFrames(event.sequence_number)) yield eventFrame(prefix);
          outputIndexOffset = 1;
          sequenceOffset = 2;
        }
      }
      const response = await rewriteResponse(event.response);
      yield eventFrame(addSequenceOffset({ ...event, response }, sequenceOffset));
      return;
    }

    if (event.type === 'response.created' || event.type === 'response.in_progress' || event.type === 'response.failed') {
      const response = prefixItem === undefined ? event.response : { ...event.response, output: [prefixItem, ...event.response.output] };
      yield eventFrame(addSequenceOffset({ ...event, response }, sequenceOffset));
      if (event.type === 'response.failed') return;
      continue;
    }

    yield eventFrame(shifted(event));
    if (event.type === 'error') return;
  }
};

export const wrapResponsesAffinityEgress = (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> =>
  ensureFirstResponsesItemAffinity(wrapNaturalResponsesAffinity(frames, options), options);
