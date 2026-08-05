import { INTER_AGENT_MESSAGE_DOMAIN, isEncryptedInterAgentCall, replaceResponsesOpaqueLocations, responsesCarrierDomain, responsesOpaqueLocations } from './opaque-locations.ts';
import type { AffinityEgressOptions } from '../../shared/affinity/index.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { createRandomResponsesItemId, type ResponsesOutputItem, type ResponsesOutputReasoning, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const wrapNaturalResponsesAffinity = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  options: AffinityEgressOptions,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const wrapped = new Map<string, Promise<string>>();
  const streamedInterAgentCalls = new Map<number, Extract<ResponsesOutputItem, { type: 'function_call' }>>();

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

  const wrapArguments = async (outputIndex: number, argumentsJson: string): Promise<string> => {
    const item = streamedInterAgentCalls.get(outputIndex);
    if (item === undefined) return argumentsJson;
    const completeItem = { ...item, arguments: argumentsJson };
    if (!responsesOpaqueLocations(completeItem).some(location => location.key === 'arguments.message')) {
      throw new TypeError('Encrypted collaboration call has no string message argument');
    }
    const wrappedItem = await wrapItem(completeItem, outputIndex);
    if (wrappedItem.type !== 'function_call') throw new TypeError('Wrapped inter-agent call changed item type');
    return wrappedItem.arguments;
  };

  const transformFrame = async function* (
    frame: ProtocolFrame<ResponsesStreamEvent>,
  ): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
    if (frame.type !== 'event') {
      yield frame;
      return;
    }
    const event = frame.event;
    if (event.type === 'response.function_call_arguments.done' && streamedInterAgentCalls.has(event.output_index)) {
      yield eventFrame({ ...event, arguments: await wrapArguments(event.output_index, event.arguments) });
      return;
    }
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      yield eventFrame({ ...event, item: await wrapItem(event.item, event.output_index) });
      return;
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
      return;
    }
    yield frame;
  };

  interface PendingArguments {
    readonly frames: ProtocolFrame<ResponsesStreamEvent>[];
    readonly blocked: Set<number>;
    readonly argumentsByIndex: Map<number, string>;
  }
  let pending: PendingArguments | undefined;
  const endsStream = (frame: ProtocolFrame<ResponsesStreamEvent>): boolean =>
    frame.type === 'event'
    && ['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(frame.event.type);

  const flushPending = async function* (
    ready: PendingArguments,
  ): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
    const rewrittenByIndex = new Map<number, ReturnType<typeof rewrittenDeltas>>();
    for (const [outputIndex, argumentsJson] of ready.argumentsByIndex) {
      const deltas = ready.frames.flatMap(queued =>
        queued.type === 'event'
        && queued.event.type === 'response.function_call_arguments.delta'
        && queued.event.output_index === outputIndex
          ? [queued.event]
          : []);
      rewrittenByIndex.set(outputIndex, rewrittenDeltas(deltas, argumentsJson));
    }
    const deltaOffsets = new Map<number, number>();
    for (const queued of ready.frames) {
      let rewritten = queued;
      let transformedPayload = false;
      if (queued.type === 'event' && queued.event.type === 'response.function_call_arguments.delta') {
        const deltas = rewrittenByIndex.get(queued.event.output_index);
        if (deltas === undefined && streamedInterAgentCalls.has(queued.event.output_index)) continue;
        if (deltas !== undefined) {
          const offset = deltaOffsets.get(queued.event.output_index) ?? 0;
          rewritten = eventFrame(deltas[offset]!);
          deltaOffsets.set(queued.event.output_index, offset + 1);
          transformedPayload = true;
        }
      } else if (queued.type === 'event' && queued.event.type === 'response.function_call_arguments.done') {
        const argumentsJson = ready.argumentsByIndex.get(queued.event.output_index);
        if (argumentsJson !== undefined) {
          rewritten = eventFrame({ ...queued.event, arguments: argumentsJson });
          transformedPayload = true;
        }
      }
      if (transformedPayload) yield rewritten;
      else yield* transformFrame(rewritten);
      if (endsStream(rewritten)) return;
    }
  };

  for await (const frame of frames) {
    const event = frame.type === 'event' ? frame.event : undefined;
    if (event?.type === 'response.output_item.added' && event.item.type === 'function_call' && isEncryptedInterAgentCall(event.item)) {
      streamedInterAgentCalls.set(event.output_index, event.item);
    }

    const encryptedDelta = event?.type === 'response.function_call_arguments.delta'
      && streamedInterAgentCalls.has(event.output_index);
    if (pending !== undefined || encryptedDelta) {
      pending ??= { frames: [], blocked: new Set(), argumentsByIndex: new Map() };
      pending.frames.push(frame);
      if (encryptedDelta && event !== undefined && 'output_index' in event) pending.blocked.add(event.output_index);
      if (event?.type === 'response.function_call_arguments.done' && streamedInterAgentCalls.has(event.output_index)) {
        pending.argumentsByIndex.set(event.output_index, await wrapArguments(event.output_index, event.arguments));
        pending.blocked.delete(event.output_index);
      }
      if (event?.type === 'response.output_item.done' && event.item.type === 'function_call' && streamedInterAgentCalls.has(event.output_index)) {
        pending.argumentsByIndex.set(event.output_index, await wrapArguments(event.output_index, event.item.arguments));
        pending.blocked.delete(event.output_index);
      }
      if (
        event?.type === 'response.completed'
        || event?.type === 'response.incomplete'
        || event?.type === 'response.failed'
      ) {
        for (const [outputIndex, call] of streamedInterAgentCalls) {
          const item = event.response.output[outputIndex];
          if (item?.type !== 'function_call' || item.call_id !== call.call_id) continue;
          pending.argumentsByIndex.set(outputIndex, await wrapArguments(outputIndex, item.arguments));
          pending.blocked.delete(outputIndex);
        }
      }
      if (pending.blocked.size > 0 && !endsStream(frame)) continue;

      const ready = pending;
      pending = undefined;
      yield* flushPending(ready);
      if (endsStream(frame)) return;
      continue;
    }

    yield* transformFrame(frame);
    if (endsStream(frame)) return;
  }

  if (pending !== undefined) {
    yield* flushPending(pending);
  }
};

const canCarryAffinity = (item: ResponsesOutputItem): boolean =>
  responsesOpaqueLocations(item).length > 0
  || isEncryptedInterAgentCall(item)
  || ['reasoning', 'compaction', 'compaction_summary', 'context_compaction', 'agent_message', 'program'].includes(item.type);

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
    if (isEncryptedInterAgentCall(item)) {
      throw new TypeError('Encrypted collaboration call has no string message argument');
    }
    if (!canCarryAffinity(item)) throw new Error(`Responses item type ${item.type} cannot carry affinity`);

    if (item.type === 'program') {
      const slot = 'fingerprint';
      const cacheKey = `${outputIndex}\0${slot}`;
      let fingerprint = syntheticCarriers.get(cacheKey);
      if (fingerprint === undefined) {
        fingerprint = options.codec.wrap(undefined, options.affinity, responsesCarrierDomain(item.type, slot));
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
      encrypted = options.codec.wrap(undefined, options.affinity, responsesCarrierDomain(item.type, slot));
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
        responsesCarrierDomain('reasoning', 'encrypted_content'),
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
