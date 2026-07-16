import type { AffinityEgressOptions, AffinityTarget } from '../../shared/affinity/index.ts';
import { createTemporaryResponsesItemId, hashResponsesItemBinding } from '../items/format.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesOutputItem, ResponsesOutputReasoning, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const carrierDomain = (itemType: string, slot: string): string => `responses.${itemType}.${slot}`;

const itemAffinity = (base: AffinityTarget, item: ResponsesOutputItem): AffinityTarget => ({
  ...base,
  ...('id' in item && typeof item.id === 'string' ? { upstreamItemId: item.id } : {}),
});

const opaqueSlots = (item: ResponsesOutputItem): Array<{ key: string; value: string }> => {
  const slots: Array<{ key: string; value: string }> = [];
  const record = item as unknown as Record<string, unknown>;
  if (typeof record.encrypted_content === 'string') {
    slots.push({ key: 'encrypted_content', value: record.encrypted_content });
  }
  if (item.type === 'program' && typeof item.fingerprint === 'string') {
    slots.push({ key: 'fingerprint', value: item.fingerprint });
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

const replaceOpaqueSlots = (
  item: ResponsesOutputItem,
  replacements: ReadonlyMap<string, string>,
): ResponsesOutputItem => {
  const record = item as unknown as Record<string, unknown>;
  const topLevel = Object.fromEntries([...replacements].filter(([key]) => !key.startsWith('content.')));
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
    ...topLevel,
    ...(content !== undefined ? { content } : {}),
  } as ResponsesOutputItem;
};

const wrapNaturalResponsesAffinity = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const wrapped = new Map<string, Promise<string>>();

  const wrapItem = async (item: ResponsesOutputItem, outputIndex: number): Promise<ResponsesOutputItem> => {
    const slots = opaqueSlots(item);
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
    return replaceOpaqueSlots(item, replacements);
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
  ['reasoning', 'compaction', 'compaction_summary', 'context_compaction', 'agent_message', 'program'].includes(item.type);

const requiresBoundCarrier = (item: ResponsesOutputItem): boolean =>
  item.type === 'program_output' && opaqueSlots(item).length === 0;

const addSequenceOffset = <T extends ResponsesStreamEvent>(event: T, offset: number): T =>
  event.sequence_number === undefined ? event : { ...event, sequence_number: event.sequence_number + offset };

const addOutputIndexOffset = <T extends ResponsesStreamEvent>(event: T, offset: number): T =>
  offset === 0 || !('output_index' in event)
    ? event
    : { ...event, output_index: event.output_index + offset } as T;

interface InsertedCarrier {
  readonly outputIndex: number;
  readonly added: ResponsesOutputReasoning;
  completed?: ResponsesOutputReasoning;
  boundItem?: NonNullable<AffinityTarget['boundItem']>;
}

const wrapResponsesCarrierLifecycle = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  // Natural opaque fields are wrapped independently above. This outer state
  // machine gives output index zero a carrier: augment a carrier-capable item
  // at close, or open a reasoning prefix immediately and complete it with the
  // canonical bound item at that item's close. Visible content is never held
  // back while the binding waits for its final ID and content hash.
  const syntheticOnFirstItem = new Map<string, Promise<string>>();
  let firstItem: { readonly outputIndex: number; readonly canCarry: boolean } | undefined;
  const insertedItems = new Map<number, InsertedCarrier>();
  let sequenceOffset = 0;

  const outputIndexOffset = (originalOutputIndex: number): number =>
    [...insertedItems.keys()].filter(insertedIndex => insertedIndex <= originalOutputIndex).length;

  const startCarrierBefore = (
    originalOutputIndex: number,
    sequenceNumber: number | undefined,
  ): ResponsesStreamEvent[] => {
    const existing = insertedItems.get(originalOutputIndex);
    if (existing !== undefined) return [];
    const added: ResponsesOutputReasoning = {
      type: 'reasoning',
      id: createTemporaryResponsesItemId('reasoning'),
      summary: [],
    };
    const shiftedOutputIndex = originalOutputIndex + outputIndexOffset(originalOutputIndex);
    insertedItems.set(originalOutputIndex, { outputIndex: shiftedOutputIndex, added });
    const shiftedSequence = sequenceNumber === undefined ? undefined : sequenceNumber + sequenceOffset;
    sequenceOffset += 1;
    return [
      {
        type: 'response.output_item.added',
        output_index: shiftedOutputIndex,
        item: added,
        ...(shiftedSequence !== undefined ? { sequence_number: shiftedSequence } : {}),
      },
    ];
  };

  const completeCarrierBefore = async (
    item: ResponsesOutputItem | undefined,
    originalOutputIndex: number,
    sequenceNumber: number | undefined,
  ): Promise<ResponsesStreamEvent[]> => {
    const inserted = insertedItems.get(originalOutputIndex);
    if (inserted === undefined) throw new Error(`Responses affinity carrier ${originalOutputIndex} completed before it started`);
    const upstreamItemId = item !== undefined && 'id' in item && typeof item.id === 'string' ? item.id : undefined;
    const boundItem = item !== undefined && upstreamItemId !== undefined
      ? { type: item.type, upstreamItemId, contentHash: await hashResponsesItemBinding(item) }
      : undefined;
    if (inserted.completed !== undefined) {
      if (
        inserted.boundItem?.type !== boundItem?.type
        || inserted.boundItem?.upstreamItemId !== boundItem?.upstreamItemId
        || inserted.boundItem?.contentHash !== boundItem?.contentHash
      ) throw new Error(`Responses output item ${originalOutputIndex} changed after its affinity binding closed`);
      return [];
    }
    const target: AffinityTarget = {
      ...options.affinity,
      syntheticItem: true,
      ...(boundItem !== undefined ? { boundItem } : {}),
    };
    const completed: ResponsesOutputReasoning = {
      ...inserted.added,
      encrypted_content: await options.codec.wrap(undefined, target, carrierDomain('reasoning', 'encrypted_content')),
    };
    inserted.completed = completed;
    inserted.boundItem = boundItem;
    const shiftedSequence = sequenceNumber === undefined ? undefined : sequenceNumber + sequenceOffset;
    sequenceOffset += 1;
    return [{
      type: 'response.output_item.done',
      output_index: inserted.outputIndex,
      item: completed,
      ...(shiftedSequence !== undefined ? { sequence_number: shiftedSequence } : {}),
    }];
  };

  const ensureItemCarrier = async (item: ResponsesOutputItem, outputIndex: number): Promise<ResponsesOutputItem> => {
    if (opaqueSlots(item).length > 0) return item;
    if (!canCarryAffinity(item)) throw new Error(`Responses item type ${item.type} cannot carry affinity`);
    const target = itemAffinity(options.affinity, item);
    const itemId = 'id' in item && typeof item.id === 'string' ? item.id : '';
    if (item.type === 'program') {
      const slot = 'fingerprint';
      const cacheKey = `${outputIndex}\0${itemId}\0${slot}`;
      let fingerprint = syntheticOnFirstItem.get(cacheKey);
      if (fingerprint === undefined) {
        fingerprint = options.codec.wrap(undefined, target, carrierDomain(item.type, slot));
        syntheticOnFirstItem.set(cacheKey, fingerprint);
      }
      return { ...item, fingerprint: await fingerprint };
    }
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

  const rewriteResponse = async (response: ResponsesResult, synthesizeMissing: boolean): Promise<ResponsesResult> => {
    let output = synthesizeMissing
      ? await Promise.all(response.output.map(async (item, index) => {
          const firstNeedsCarrier = firstItem?.canCarry
            && index === firstItem.outputIndex
            && !insertedItems.has(index);
          return firstNeedsCarrier || (item.type === 'program' && opaqueSlots(item).length === 0)
            ? await ensureItemCarrier(item, index)
            : item;
        }))
      : response.output;
    const interleaved: ResponsesOutputItem[] = [];
    for (let index = 0; index <= output.length; index += 1) {
      const inserted = insertedItems.get(index);
      if (inserted !== undefined) interleaved.push(inserted.completed ?? inserted.added);
      if (output[index] !== undefined) interleaved.push(output[index]);
    }
    output = interleaved;
    return { ...response, output };
  };

  const shifted = (event: ResponsesStreamEvent): ResponsesStreamEvent =>
    addSequenceOffset(
      addOutputIndexOffset(event, 'output_index' in event ? outputIndexOffset(event.output_index) : 0),
      sequenceOffset,
    );

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }

    const event = frame.event;
    if (event.type === 'response.output_item.added') {
      if (firstItem === undefined) {
        firstItem = { outputIndex: event.output_index, canCarry: canCarryAffinity(event.item) };
        if (!firstItem.canCarry) {
          for (const inserted of startCarrierBefore(event.output_index, event.sequence_number)) yield eventFrame(inserted);
        }
      } else if (requiresBoundCarrier(event.item)) {
        for (const inserted of startCarrierBefore(event.output_index, event.sequence_number)) yield eventFrame(inserted);
      }
      yield eventFrame(shifted(event));
      continue;
    }

    if (event.type === 'response.output_item.done') {
      if (requiresBoundCarrier(event.item) && !insertedItems.has(event.output_index)) {
        for (const inserted of startCarrierBefore(event.output_index, event.sequence_number)) yield eventFrame(inserted);
      }
      if (insertedItems.has(event.output_index)) {
        for (const inserted of await completeCarrierBefore(event.item, event.output_index, event.sequence_number)) yield eventFrame(inserted);
      }
      const item = (firstItem?.canCarry
        && event.output_index === firstItem.outputIndex
        && !insertedItems.has(event.output_index))
        || (event.item.type === 'program' && opaqueSlots(event.item).length === 0)
        ? await ensureItemCarrier(event.item, event.output_index)
        : event.item;
      yield eventFrame(shifted({ ...event, item }));
      continue;
    }

    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      if (firstItem === undefined) {
        const first = event.response.output[0];
        if (first !== undefined && canCarryAffinity(first)) {
          firstItem = { outputIndex: 0, canCarry: true };
        } else {
          for (const inserted of startCarrierBefore(0, event.sequence_number)) yield eventFrame(inserted);
          firstItem = first === undefined ? undefined : { outputIndex: 0, canCarry: false };
        }
      }
      for (const [outputIndex, item] of event.response.output.entries()) {
        if (requiresBoundCarrier(item) && !insertedItems.has(outputIndex)) {
          for (const inserted of startCarrierBefore(outputIndex, event.sequence_number)) yield eventFrame(inserted);
        }
      }
      for (const outputIndex of insertedItems.keys()) {
        const item = event.response.output[outputIndex];
        for (const completed of await completeCarrierBefore(item, outputIndex, event.sequence_number)) yield eventFrame(completed);
      }
      const response = await rewriteResponse(event.response, true);
      yield eventFrame(addSequenceOffset({ ...event, response }, sequenceOffset));
      return;
    }

    if (event.type === 'response.created' || event.type === 'response.in_progress' || event.type === 'response.failed') {
      const response = await rewriteResponse(event.response, false);
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
  wrapResponsesCarrierLifecycle(wrapNaturalResponsesAffinity(frames, options), options);
