import { collectAnthropicMessagesTextViews, computeAnthropicMessagesTurnDigest, createAnthropicMessagesSidecarCarrier } from './round-trip.ts';
import { usageFromIR } from './usage.ts';
import type { IRCollector } from '../../../ir/collector.ts';
import { isIRItemPath, isIRPartPath, irPathKey } from '../../../ir/operation-paths.ts';
import { createIROrdinalMapper } from '../../../ir/ordinal-mapper.ts';
import { consumeIRRecords, type IRPath, type IRRecord } from '../../../ir/stream.ts';
import { IRAbsent, type IR, type IRErrorPayload, type IRJSONObject } from '../../../ir/types.ts';
import { createIRUnitQueue, createIRUnitRegistry } from '../../../ir/unit-queue.ts';
import { appendContent, createContentState, type ContentState, type ContentStates } from '../../../round-trip/reference/reference-builder.ts';
import { provenanceSpanForAppend, replayTextProvenance, type TextProvenanceSpan } from '../../../round-trip/reference/text-provenance.ts';
import type { RoundTripOutputOptions } from '../../../round-trip/stream.ts';
import { isContextExceededError } from '../../../shared/context-window-error.ts';
import { parseJSONObject, parseJSONObjectAtCompletion, requireJSONObject } from '../../../shared/json/object.ts';
import type { AnthropicMessagesAssistantState, AnthropicMessagesInputAssistantTurn } from '../as-target/assistant-turn.ts';
import {
  generateAnthropicId,
  createAnthropicMessagesEventAccumulator,
  PROMPT_TOO_LONG_MESSAGE,
  type AnthropicMessagesAssistantContentBlock,
  type AnthropicMessagesContentBlockDeltaEvent,
  type AnthropicMessagesErrorEventEx,
  type AnthropicMessagesResult,
  type AnthropicMessagesStreamEventEx,
  type AnthropicMessagesUsage,
} from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type EventFrame } from '@floway-dev/protocols/common';

const MESSAGES_ERROR_TYPES = [
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'rate_limit_error',
  'api_error',
  'overloaded_error',
];

const irMessagesError = (error: IRErrorPayload): AnthropicMessagesErrorEventEx['error'] => isContextExceededError(error)
  ? { type: 'invalid_request_error', message: PROMPT_TOO_LONG_MESSAGE }
  : { type: error.type !== undefined && MESSAGES_ERROR_TYPES.includes(error.type) ? error.type : 'api_error', message: error.message };

interface MessagesUnit {
  readonly path: IRPath;
  readonly kind: 'text' | 'refusal' | 'audio' | 'image' | 'reasoning' | 'function_call';
  opened: boolean;
  textContentState?: ContentState<'text'>;
  // Keep source intervals until their native field is emitted, including terminal JSON normalization.
  pendingText?: Map<string, TextProvenanceSpan[]>;
  nextPending?: MessagesUnit;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const unitKind = (value: unknown): MessagesUnit['kind'] | 'custom_tool_call' | undefined => {
  if (!isRecord(value)) return undefined;
  return value.type === 'text'
    || value.type === 'refusal'
    || value.type === 'audio'
    || value.type === 'image'
    || value.type === 'reasoning'
    || value.type === 'function_call'
    || value.type === 'custom_tool_call'
    ? value.type
    : undefined;
};

const isPartKind = (kind: MessagesUnit['kind']): boolean =>
  kind === 'text' || kind === 'refusal' || kind === 'audio' || kind === 'image';

// Translated thinking has no upstream Messages signature. Clients and the affinity layer
// expect a non-empty base64 value, so we emit the shortest canonical one.
const TRANSLATED_THINKING_SIGNATURE = 'AA==';

type IRAppendRecord = Extract<IRRecord, { type: 'write'; kind: 'append' }>;

const outputTextKind = (unit: MessagesUnit, record: IRAppendRecord): 'text' | 'thinking' | 'input' | undefined => {
  const field = record.path.at(-1);
  if ((unit.kind === 'text' || unit.kind === 'refusal' || unit.kind === 'audio')
    && (field === 'text' || field === 'refusal' || field === 'transcript')) return 'text';
  if (unit.kind === 'reasoning' && (record.path[4] === 'summary' || record.path[4] === 'content')) return 'thinking';
  if (unit.kind === 'function_call' && record.path[4] === 'arguments') return 'input';
  return undefined;
};

interface AnthropicMessagesSSEOutputOptions extends RoundTripOutputOptions<'anthropicMessages'> {
  parseToolArguments?: (text: string) => IRJSONObject;
}

export const anthropicMessagesFromIR = async function* (
  records: AsyncIterable<IRRecord>,
  options: AnthropicMessagesSSEOutputOptions,
): AsyncGenerator<EventFrame<AnthropicMessagesStreamEventEx>> {
  let metadata = { id: '', model: '' };
  let started = false;
  let finishReason: NonNullable<AnthropicMessagesResult['stop_reason']> = 'end_turn';
  const units = createIRUnitRegistry<MessagesUnit>();
  const pending = createIRUnitQueue<MessagesUnit>();
  const ordinals = createIROrdinalMapper();
  const nativeAccumulator = createAnthropicMessagesEventAccumulator();
  const contentState: NonNullable<AnthropicMessagesAssistantState<ContentStates>['content']> = [];
  let nextBlockIndex = 0;
  // Keep only the frontier block wire-open so the finish-time sidecar can close
  // before it. Clients that require serial blocks reorder this in the gateway.
  let pendingBlockStop: EventFrame<AnthropicMessagesStreamEventEx> | undefined;
  const emit = (event: AnthropicMessagesStreamEventEx): EventFrame<AnthropicMessagesStreamEventEx> => {
    if (event.type !== 'error') nativeAccumulator.accept(event);
    return eventFrame(event);
  };

  const blockDelta = (index: number, delta: AnthropicMessagesContentBlockDeltaEvent['delta']): EventFrame<AnthropicMessagesStreamEventEx> =>
    emit({ type: 'content_block_delta', index, delta });

  const usage = (state: IR): AnthropicMessagesUsage => {
    const value = usageFromIR(state.usage ?? {});
    if (state.service_tier === 'fast') value.speed = 'fast';
    else if (typeof state.service_tier === 'string') value.service_tier = state.service_tier;
    return value;
  };

  // Queues the content blocks that the IR structures initialized by a record will become.
  const registerUnits = (record: IRRecord, state: IR): void => {
    if (record.type === 'write' && record.kind === 'initialize') {
      let path: IRPath | undefined;
      let kind: MessagesUnit['kind'] | undefined;
      if (isIRItemPath(record.path, state)) {
        const itemKind = unitKind(record.value);
        if (itemKind === 'custom_tool_call') throw new TypeError('Messages cannot represent custom tool calls');
        if (itemKind === 'reasoning' || itemKind === 'function_call') {
          path = record.path;
          kind = itemKind;
        }
      } else if (isIRPartPath(record.path, state)) {
        const partKind = unitKind(record.value);
        if (partKind !== undefined && partKind !== 'custom_tool_call' && isPartKind(partKind)) {
          path = record.path;
          kind = partKind;
        }
      }
      if (path !== undefined && !units.has(path)) {
        if (kind === undefined) throw new TypeError('Messages unit initialization requires a supported unit');
        const unit = { path, kind, opened: false };
        pending.enqueue(unit);
        units.set(path, unit);
      }
    }
  };

  const appendPendingText = (unit: MessagesUnit, path: IRPath, text: string, content: ContentState): void => {
    const key = irPathKey(path);
    replayTextProvenance(text, unit.pendingText?.get(key) ?? [], (value, referencePieceIds) => {
      appendContent(options.roundTrip.builder, content, value, referencePieceIds);
    });
    unit.pendingText?.delete(key);
  };

  // Opens the waiting units in IR order, until one still lacks what its start event needs.
  const openPendingUnits = (state: IR, collector: IRCollector): AnthropicMessagesStreamEventEx[] => {
    const pendingEvents: AnthropicMessagesStreamEventEx[] = [];
    while (pending.head !== undefined) {
      const unit = pending.head;
      const itemIndex = unit.path[3] as number;
      // A queued block may have accumulated fields before an earlier block allowed it to open.
      const item = state.choices[0].items[itemIndex];
      const partIndex = isPartKind(unit.kind) ? unit.path[5] as number : undefined;
      const part = item.type === 'message' && partIndex !== undefined ? item.content[partIndex] : undefined;
      const closed = !collector.isOpen(unit.path);
      let block: AnthropicMessagesAssistantContentBlock | undefined;
      let wait = false;
      if (item.type === 'message') {
        if (part?.type === 'text' || part?.type === 'refusal') block = { type: 'text', text: '', citations: [] };
        else if (part?.type === 'audio') {
          if (part.audio.transcript !== undefined) block = { type: 'text', text: '', citations: [] };
          else wait = !closed;
        }
      } else if (item.type === 'reasoning') {
        const hasTextShape = item.summary !== undefined || item.content !== undefined;
        if (hasTextShape) block = { type: 'thinking', thinking: '', signature: '' };
        else wait = !closed;
      } else if (item.type === 'function_call') {
        if (item.name === '') throw new TypeError('Completed tool calls require a name');
        const callId = collector.optional<string>([...unit.path, 'call_id']);
        if (callId === undefined) wait = true;
        else block = { type: 'tool_use', id: callId === IRAbsent ? `${metadata.id}_${itemIndex}` : callId, name: item.name, input: {} };
      }
      if (wait) break;
      pending.dequeue();
      if (block === undefined) { units.delete(unit.path); continue; }
      unit.opened = true;
      const index = ordinals.open(unit.path);
      if (block.type === 'thinking' || block.type === 'text') {
        unit.textContentState ??= createContentState(options.roundTrip.builder, 'text');
        contentState[index] = block.type === 'thinking' ? { thinking: unit.textContentState } : { text: unit.textContentState };
      }
      nextBlockIndex = Math.max(nextBlockIndex, index + 1);
      pendingEvents.push({ type: 'content_block_start', index, content_block: block });
      const delta = (value: AnthropicMessagesContentBlockDeltaEvent['delta']): void => {
        pendingEvents.push({ type: 'content_block_delta', index, delta: value });
      };
      if (item.type === 'message' && part !== undefined) {
        const text = part.type === 'text' ? part.text : part.type === 'refusal' ? part.refusal : part.type === 'audio' ? part.audio.transcript ?? '' : '';
        if (unit.textContentState === undefined) throw new Error('Missing Messages text content state');
        const path = [...unit.path, ...(part.type === 'audio' ? ['audio', 'transcript'] : [part.type === 'refusal' ? 'refusal' : 'text'])];
        appendPendingText(unit, path, text, unit.textContentState);
        if (text !== '') delta({ type: 'text_delta', text });
      } else if (item.type === 'reasoning' && block.type === 'thinking') {
        const thinkingState = unit.textContentState;
        if (thinkingState === undefined) throw new Error('Missing Messages thinking content state');
        for (const field of ['summary', 'content'] as const) (item[field] ?? []).forEach((text, index) => {
          appendPendingText(unit, [...unit.path, field, index], text, thinkingState);
        });
        const text = [...item.summary ?? [], ...item.content ?? []].join('');
        if (text !== '') delta({ type: 'thinking_delta', thinking: text });
      } else if (item.type === 'function_call' && options.parseToolArguments === undefined && item.arguments !== '') {
        delta({ type: 'input_json_delta', partial_json: item.arguments });
      }
    }
    return pendingEvents;
  };

  for await (const { record, collector } of consumeIRRecords(records)) {
    const { state } = collector;
    if (record.type === 'error') { yield emit({ type: 'error', error: irMessagesError(record.error) }); return; }
    if (record.type === 'write' && record.path[0] === 'model' && typeof record.value === 'string') metadata.model = record.value;
    if (record.type === 'start') {
      if (state.model === undefined) throw new TypeError('Messages output requires an IR model before start');
      const id = options.id ?? record.id;
      metadata = { id: id === undefined || id === '' ? generateAnthropicId('msg') : id, model: state.model };
      yield emit({
        type: 'message_start',
        message: {
          id: metadata.id,
          type: 'message',
          role: 'assistant',
          model: metadata.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          stop_details: null,
          container: null,
          usage: usage(state),
        },
      });
      started = true;
      continue;
    }
    if (!started) continue;
    if (record.type === 'write' && record.path[0] === 'choices' && record.path[1] !== 0) throw new Error('Messages cannot represent multiple choices');
    if (record.type === 'ping') { yield emit({ type: 'ping' }); continue; }
    if (record.type === 'choice_end') {
      if (record.choice !== 0) throw new Error('Messages cannot represent multiple choices');
      finishReason = record.finish_reason === 'length' ? 'max_tokens'
        : record.finish_reason === 'tool_calls' ? 'tool_use'
          : record.finish_reason === 'content_filter' ? 'refusal' : 'end_turn';
      for (const item of state.choices[0].items) if (item.type === 'function_call') {
        parseJSONObjectAtCompletion(item.arguments, record.finish_reason === 'length' ? 'truncated' : 'complete', options.parseToolArguments);
      }
      continue;
    }

    registerUnits(record, state);
    const pendingUnit = units.forRecord(record, state);
    if (pendingUnit !== undefined && record.type === 'write' && record.kind === 'append') {
      const kind = outputTextKind(pendingUnit, record);
      if (kind !== undefined && (!pendingUnit.opened || kind === 'input')) {
        const text = collector.value<string>(record.path);
        if (text === undefined) throw new Error('Missing pending Messages text');
        const fields = pendingUnit.pendingText ??= new Map();
        const key = irPathKey(record.path);
        const atoms = fields.get(key) ?? [];
        atoms.push(provenanceSpanForAppend(text, record.value, record.referencePieceIds));
        fields.set(key, atoms);
      } else if (kind !== undefined) {
        if (pendingUnit.textContentState === undefined) throw new Error('Missing Messages text content state');
        appendContent(options.roundTrip.builder, pendingUnit.textContentState, record.value, record.referencePieceIds);
      }
    }
    for (const event of openPendingUnits(state, collector)) {
      if (event.type === 'content_block_start' && pendingBlockStop !== undefined) {
        yield pendingBlockStop;
        pendingBlockStop = undefined;
      }
      yield emit(event);
    }

    const unit = units.forRecord(record, state);
    if (unit?.opened && record.type === 'write') {
      const index = ordinals.get(unit.path);
      if (record.kind === 'append') {
        const kind = outputTextKind(unit, record);
        if (kind === 'text') {
          yield blockDelta(index, { type: 'text_delta', text: record.value });
        } else if (kind === 'thinking') {
          yield blockDelta(index, { type: 'thinking_delta', thinking: record.value });
        } else if (kind === 'input' && options.parseToolArguments === undefined) {
          yield blockDelta(index, { type: 'input_json_delta', partial_json: record.value });
        }
      }
    }

    if ((record.type === 'item_end' || record.type === 'part_end') && unit !== undefined) {
      if (unit.opened) {
        const index = ordinals.get(unit.path);
        let serializedInput: string | undefined;
        if (unit.kind === 'function_call') {
          // Tool validation and optional repair run on the complete terminal arguments.
          const item = state.choices[0].items[unit.path[3] as number];
          if (item.type !== 'function_call') throw new TypeError('Messages function unit requires a function item');
          if (options.parseToolArguments !== undefined) {
            const parsed = parseJSONObject(item.arguments, options.parseToolArguments);
            const serialized = JSON.stringify(parsed);
            serializedInput = serialized;
            if (serialized !== '') yield blockDelta(index, { type: 'input_json_delta', partial_json: serialized });
          } else {
            const parsed = parseJSONObjectAtCompletion(item.arguments, record.type === 'item_end' && record.status === 'incomplete' ? 'truncated' : 'complete');
            if (parsed.completion === 'complete') serializedInput = JSON.stringify(parsed.value);
          }
        }
        if (unit.kind === 'reasoning') yield blockDelta(index, { type: 'signature_delta', signature: TRANSLATED_THINKING_SIGNATURE });
        const stop = emit({ type: 'content_block_stop', index });
        if (unit.kind === 'function_call') {
          if (serializedInput === undefined) {
            const block = nativeAccumulator.contentBlock(index);
            if (block?.type !== 'tool_use') throw new Error('Messages function unit did not produce a native tool block');
            serializedInput = JSON.stringify(requireJSONObject(block.input));
          }
          const content = createContentState(options.roundTrip.builder, 'json');
          contentState[index] = { input: content };
          const item = state.choices[0].items[unit.path[3] as number];
          if (item.type !== 'function_call') throw new Error('Messages function unit requires a function item');
          if (serializedInput === item.arguments) appendPendingText(unit, [...unit.path, 'arguments'], serializedInput, content);
          else appendContent(options.roundTrip.builder, content, serializedInput);
        }
        ordinals.close(unit.path);
        if (nextBlockIndex > index + 1) yield stop;
        else {
          if (pendingBlockStop !== undefined) throw new Error('Messages cannot defer more than one content block stop');
          pendingBlockStop = stop;
        }
      }
      units.delete(unit.path);
    }

    if (record.type === 'write' && record.path[0] === 'usage') {
      yield emit({ type: 'message_delta', delta: { stop_reason: null, stop_sequence: null, stop_details: null, container: null }, usage: usage(state) });
    }
    if (record.type === 'finish') {
      const nativeResult = nativeAccumulator.result();
      contentState.length = nativeResult.content.length;
      const targetTurn: AnthropicMessagesInputAssistantTurn = {
        role: 'assistant',
        content: nativeResult.content.map(block => block.type === 'tool_use' ? { ...block, input: requireJSONObject(block.input) } : block),
      };
      const assistantState: AnthropicMessagesAssistantState<ContentStates> = { content: contentState };
      const sourceTurnDigest = await computeAnthropicMessagesTurnDigest([targetTurn]);
      const data = await options.roundTrip.prepareSidecar(0, sourceTurnDigest, targetTurn, assistantState, collectAnthropicMessagesTextViews([targetTurn]));
      const carrier = createAnthropicMessagesSidecarCarrier(data);
      yield emit({ type: 'content_block_start', index: nextBlockIndex, content_block: carrier });
      yield emit({ type: 'content_block_stop', index: nextBlockIndex });
      if (pendingBlockStop !== undefined) {
        yield pendingBlockStop;
        pendingBlockStop = undefined;
      }
      const refusal = state.choices[0]?.refusal;
      yield emit({
        type: 'message_delta',
        delta: {
          stop_reason: finishReason,
          stop_sequence: null,
          stop_details: refusal === undefined ? null : { type: 'refusal', ...refusal },
          container: null,
        },
        usage: usage(state),
      });
      yield emit({ type: 'message_stop' });
    }
  }
};
