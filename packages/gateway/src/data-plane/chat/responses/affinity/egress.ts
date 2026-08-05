import type { AffinityEgressOptions } from '../../shared/affinity/index.ts';
import { INTER_AGENT_MESSAGE_DOMAIN, isEncryptedInterAgentCall, replaceResponsesOpaqueLocations, responsesOpaqueLocations } from './opaque-locations.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { createRandomResponsesItemId, type ResponsesOutputItem, type ResponsesOutputReasoning, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const canonicalItemType = (itemType: string): string =>
  itemType === 'compaction_summary' ? 'compaction' : itemType;

const carrierDomain = (itemType: string, slot: string): string =>
  `responses.${canonicalItemType(itemType)}.${slot}`;

const wrapNaturalResponsesAffinity = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const wrapped = new Map<string, Promise<string>>();
  const streamedInterAgentCalls = new Map<number, {
    readonly item: Extract<ResponsesOutputItem, { type: 'function_call' }>;
    readonly deltas: Array<Extract<ResponsesStreamEvent, { type: 'response.function_call_arguments.delta' }>>;
  }>();

  const wrapItem = async (item: ResponsesOutputItem, outputIndex: number): Promise<ResponsesOutputItem> => {
    const replacements = new Map<string, string>();
    await Promise.all(responsesOpaqueLocations(item).map(async location => {
      const cacheKey = `${outputIndex}\0${location.key}\0${location.value}`;
      let replacement = wrapped.get(cacheKey);
      if (replacement === undefined) {
        replacement = options.codec.wrap(location.value, options.affinity, location.domain);
        wrapped.set(cacheKey, replacement);
      }
      replacements.set(location.key, await replacement);
    }));
    return replacements.size === 0 ? item : replaceResponsesOpaqueLocations(item, replacements);
  };

  const rewrittenDeltas = (
    deltas: readonly Extract<ResponsesStreamEvent, { type: 'response.function_call_arguments.delta' }>[],
    argumentsJson: string,
  ): Array<Extract<ResponsesStreamEvent, { type: 'response.function_call_arguments.delta' }>> => {
    let offset = 0;
    return deltas.map((event, index) => {
      const delta = index === deltas.length - 1
        ? argumentsJson.slice(offset)
        : argumentsJson.slice(offset, offset + event.delta.length);
      offset += delta.length;
      return { ...event, delta };
    });
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
    if (event.type === 'response.output_item.added' && event.item.type === 'function_call' && isEncryptedInterAgentCall(event.item)) {
      streamedInterAgentCalls.set(event.output_index, { item: event.item, deltas: [] });
    }
    if (event.type === 'response.function_call_arguments.delta') {
      const call = streamedInterAgentCalls.get(event.output_index);
      if (call !== undefined) {
        call.deltas.push(event);
        continue;
      }
    }
    if (event.type === 'response.function_call_arguments.done') {
      const call = streamedInterAgentCalls.get(event.output_index);
      if (call !== undefined) {
        const item = await wrapItem({ ...call.item, arguments: event.arguments }, event.output_index);
        if (item.type !== 'function_call') throw new TypeError('Wrapped inter-agent call changed item type');
        for (const delta of rewrittenDeltas(call.deltas, item.arguments)) yield eventFrame(delta);
        yield eventFrame({ ...event, arguments: item.arguments });
        continue;
      }
    }
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

const canCarryAffinity = (item: ResponsesOutputItem): boolean =>
  ['reasoning', 'compaction', 'compaction_summary', 'context_compaction', 'agent_message', 'program'].includes(item.type);

const addSequenceOffset = <T extends ResponsesStreamEvent>(event: T, offset: number): T =>
  event.sequence_number === undefined ? event : { ...event, sequence_number: event.sequence_number + offset };

interface SyntheticPrefix {
  readonly originalOutputIndex: number;
  readonly item: ResponsesOutputReasoning;
}

const wrapResponsesFirstCarrier = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const syntheticCarriers = new Map<string, Promise<string>>();
  let firstItem: { readonly outputIndex: number; readonly canCarry: boolean } | undefined;
  let prefix: SyntheticPrefix | undefined;
  let sequenceOffset = 0;

  const outputIndexOffset = (outputIndex: number): number =>
    prefix !== undefined && outputIndex >= prefix.originalOutputIndex ? 1 : 0;

  const shifted = (event: ResponsesStreamEvent): ResponsesStreamEvent => {
    const outputShifted = prefix !== undefined && 'output_index' in event
      ? { ...event, output_index: event.output_index + outputIndexOffset(event.output_index) } as ResponsesStreamEvent
      : event;
    return addSequenceOffset(outputShifted, sequenceOffset);
  };

  const ensureItemCarrier = async (item: ResponsesOutputItem, outputIndex: number): Promise<ResponsesOutputItem> => {
    if (responsesOpaqueLocations(item).length > 0) return item;
    if (!canCarryAffinity(item)) throw new Error(`Responses item type ${item.type} cannot carry affinity`);

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
        encrypted = options.codec.wrap(undefined, options.affinity, INTER_AGENT_MESSAGE_DOMAIN);
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
    return { ...item, encrypted_content: await encrypted } as ResponsesOutputItem;
  };

  const insertPrefix = async function* (
    originalOutputIndex: number,
    sequenceNumber: number | undefined,
  ): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
    if (prefix !== undefined) return;
    const added: ResponsesOutputReasoning = {
      type: 'reasoning',
      id: createRandomResponsesItemId('reasoning'),
      summary: [],
    };
    const item: ResponsesOutputReasoning = {
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

  const rewriteResponse = async (response: ResponsesResult, synthesizeFirst: boolean): Promise<ResponsesResult> => {
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
    response: ResponsesResult,
    sequenceNumber: number | undefined,
  ): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
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

export const wrapResponsesAffinityEgress = (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> =>
  wrapResponsesFirstCarrier(wrapNaturalResponsesAffinity(frames, options), options);
