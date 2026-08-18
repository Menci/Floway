import type { AffinityEgressOptions } from '../../shared/affinity/index.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { createRandomOpenAIResponsesItemId, type OpenAIResponsesOutputItem, type OpenAIResponsesOutputReasoning, type OpenAIResponsesResult, type OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

const canonicalItemType = (itemType: string): string =>
  itemType === 'compaction_summary' ? 'compaction' : itemType;

const carrierDomain = (itemType: string, slot: string): string =>
  `openai-responses.${canonicalItemType(itemType)}.${slot}`;

const opaqueSlots = (item: OpenAIResponsesOutputItem): Array<{ key: string; value: string }> => {
  const slots: Array<{ key: string; value: string }> = [];
  const record = item as unknown as Record<string, unknown>;
  if (typeof record.encrypted_content === 'string') {
    slots.push({ key: 'encrypted_content', value: record.encrypted_content });
  }
  if (item.type === 'program' && typeof item.fingerprint === 'string') {
    slots.push({ key: 'fingerprint', value: item.fingerprint });
  }
  if (item.type === 'agent_message') {
    item.content.forEach((content, index) => {
      if (content.type === 'encrypted_content' && typeof content.encrypted_content === 'string') {
        slots.push({ key: `content.${index}.encrypted_content`, value: content.encrypted_content });
      }
    });
  }
  return slots;
};

const replaceOpaqueSlots = (
  item: OpenAIResponsesOutputItem,
  replacements: ReadonlyMap<string, string>,
): OpenAIResponsesOutputItem => {
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
  } as OpenAIResponsesOutputItem;
};

const wrapNaturalOpenAIResponsesAffinity = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
  const wrapped = new Map<string, Promise<string>>();

  const wrapItem = async (item: OpenAIResponsesOutputItem, outputIndex: number): Promise<OpenAIResponsesOutputItem> => {
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

  const wrapResult = async (response: OpenAIResponsesResult): Promise<OpenAIResponsesResult> => ({
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

const canCarryAffinity = (item: OpenAIResponsesOutputItem): boolean =>
  ['reasoning', 'compaction', 'compaction_summary', 'context_compaction', 'agent_message', 'program'].includes(item.type);

const addSequenceOffset = <T extends OpenAIResponsesStreamEvent>(event: T, offset: number): T =>
  event.sequence_number === undefined ? event : { ...event, sequence_number: event.sequence_number + offset };

interface SyntheticPrefix {
  readonly originalOutputIndex: number;
  readonly item: OpenAIResponsesOutputReasoning;
}

const wrapOpenAIResponsesFirstCarrier = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
  const syntheticCarriers = new Map<string, Promise<string>>();
  let firstItem: { readonly outputIndex: number; readonly canCarry: boolean } | undefined;
  let prefix: SyntheticPrefix | undefined;
  let sequenceOffset = 0;

  const outputIndexOffset = (outputIndex: number): number =>
    prefix !== undefined && outputIndex >= prefix.originalOutputIndex ? 1 : 0;

  const shifted = (event: OpenAIResponsesStreamEvent): OpenAIResponsesStreamEvent => {
    const outputShifted = prefix !== undefined && 'output_index' in event
      ? { ...event, output_index: event.output_index + outputIndexOffset(event.output_index) } as OpenAIResponsesStreamEvent
      : event;
    return addSequenceOffset(outputShifted, sequenceOffset);
  };

  const ensureItemCarrier = async (item: OpenAIResponsesOutputItem, outputIndex: number): Promise<OpenAIResponsesOutputItem> => {
    if (opaqueSlots(item).length > 0) return item;
    if (!canCarryAffinity(item)) throw new Error(`OpenAI Responses item type ${item.type} cannot carry affinity`);

    if (item.type === 'program') {
      const slot = 'fingerprint';
      const cacheKey = `${outputIndex}\0${slot}`;
      let fingerprint = syntheticCarriers.get(cacheKey);
      if (fingerprint === undefined) {
        fingerprint = options.codec.wrap(undefined, options.affinity, carrierDomain(item.type, slot));
        syntheticCarriers.set(cacheKey, fingerprint);
      }
      return { ...item, fingerprint: await fingerprint };
    }
    if (item.type === 'agent_message') {
      const slot = `content.${item.content.length}.encrypted_content`;
      const cacheKey = `${outputIndex}\0${slot}`;
      let encrypted = syntheticCarriers.get(cacheKey);
      if (encrypted === undefined) {
        encrypted = options.codec.wrap(undefined, options.affinity, carrierDomain(item.type, slot));
        syntheticCarriers.set(cacheKey, encrypted);
      }
      return { ...item, content: [...item.content, { type: 'encrypted_content', encrypted_content: await encrypted }] };
    }

    const slot = 'encrypted_content';
    const cacheKey = `${outputIndex}\0${slot}`;
    let encrypted = syntheticCarriers.get(cacheKey);
    if (encrypted === undefined) {
      encrypted = options.codec.wrap(undefined, options.affinity, carrierDomain(item.type, slot));
      syntheticCarriers.set(cacheKey, encrypted);
    }
    return { ...item, encrypted_content: await encrypted } as OpenAIResponsesOutputItem;
  };

  const insertPrefix = async function* (
    originalOutputIndex: number,
    sequenceNumber: number | undefined,
  ): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    if (prefix !== undefined) return;
    const added: OpenAIResponsesOutputReasoning = {
      type: 'reasoning',
      id: createRandomOpenAIResponsesItemId('reasoning'),
      summary: [],
    };
    const item: OpenAIResponsesOutputReasoning = {
      ...added,
      encrypted_content: await options.codec.wrap(
        undefined,
        options.affinity,
        carrierDomain('reasoning', 'encrypted_content'),
        { syntheticItem: true },
      ),
    };
    prefix = { originalOutputIndex, item };

    const addedSequence = sequenceNumber === undefined ? undefined : sequenceNumber + sequenceOffset;
    sequenceOffset += 1;
    yield eventFrame({
      type: 'response.output_item.added',
      output_index: prefix.originalOutputIndex,
      item: added,
      ...(addedSequence !== undefined ? { sequence_number: addedSequence } : {}),
    });

    const doneSequence = sequenceNumber === undefined ? undefined : sequenceNumber + sequenceOffset;
    sequenceOffset += 1;
    yield eventFrame({
      type: 'response.output_item.done',
      output_index: prefix.originalOutputIndex,
      item,
      ...(doneSequence !== undefined ? { sequence_number: doneSequence } : {}),
    });
  };

  const rewriteResponse = async (response: OpenAIResponsesResult, synthesizeFirst: boolean): Promise<OpenAIResponsesResult> => {
    let output = response.output;
    if (synthesizeFirst && firstItem?.canCarry) {
      const firstOutputIndex = firstItem.outputIndex;
      output = await Promise.all(output.map(async (item, index) =>
        index === firstOutputIndex ? await ensureItemCarrier(item, index) : item));
    }
    if (prefix === undefined) return { ...response, output };
    return {
      ...response,
      output: [
        ...output.slice(0, prefix.originalOutputIndex),
        prefix.item,
        ...output.slice(prefix.originalOutputIndex),
      ],
    };
  };

  const discoverFirstFromSnapshot = async function* (
    response: OpenAIResponsesResult,
    sequenceNumber: number | undefined,
  ): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    if (firstItem !== undefined || response.output[0] === undefined) return;
    const item = response.output[0];
    firstItem = { outputIndex: 0, canCarry: canCarryAffinity(item) };
    if (!firstItem.canCarry) yield* insertPrefix(0, sequenceNumber);
  };

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      yield frame;
      continue;
    }
    const event = frame.event;

    if (event.type === 'response.output_item.added') {
      if (firstItem === undefined) {
        firstItem = { outputIndex: event.output_index, canCarry: canCarryAffinity(event.item) };
        if (!firstItem.canCarry) yield* insertPrefix(event.output_index, event.sequence_number);
      }
      yield eventFrame(shifted(event));
      continue;
    }

    if (event.type === 'response.output_item.done') {
      if (firstItem === undefined) {
        firstItem = { outputIndex: event.output_index, canCarry: canCarryAffinity(event.item) };
        if (!firstItem.canCarry) yield* insertPrefix(event.output_index, event.sequence_number);
      }
      const item = firstItem.canCarry && event.output_index === firstItem.outputIndex
        ? await ensureItemCarrier(event.item, event.output_index)
        : event.item;
      yield eventFrame(shifted({ ...event, item }));
      continue;
    }

    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      if (firstItem === undefined) {
        const item = event.response.output[0];
        firstItem = item === undefined ? undefined : { outputIndex: 0, canCarry: canCarryAffinity(item) };
        if (!firstItem?.canCarry) yield* insertPrefix(0, event.sequence_number);
      }
      const response = await rewriteResponse(event.response, true);
      yield eventFrame(addSequenceOffset({ ...event, response }, sequenceOffset));
      return;
    }

    if (event.type === 'response.queued') {
      const response = await rewriteResponse(event.response, false);
      yield eventFrame(addSequenceOffset({ ...event, response }, sequenceOffset));
      continue;
    }

    if (event.type === 'response.created' || event.type === 'response.in_progress') {
      yield* discoverFirstFromSnapshot(event.response, event.sequence_number);
      const response = await rewriteResponse(event.response, false);
      yield eventFrame(addSequenceOffset({ ...event, response }, sequenceOffset));
      continue;
    }

    if (event.type === 'response.failed') {
      const response = await rewriteResponse(event.response, false);
      yield eventFrame(addSequenceOffset({ ...event, response }, sequenceOffset));
      return;
    }

    yield eventFrame(shifted(event));
    if (event.type === 'error') return;
  }
};

export const wrapOpenAIResponsesAffinityEgress = (
  frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> =>
  wrapOpenAIResponsesFirstCarrier(wrapNaturalOpenAIResponsesAffinity(frames, options), options);
