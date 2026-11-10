import { restoreNamespaceOutputItem, type NamespaceToolNames } from './namespace-tools.ts';
import { createRandomOpenAIResponsesResponseId } from './response-id.ts';
import { collectOpenAIResponsesTextViews, computeOpenAIResponsesTurnDigest, createOpenAIResponsesSidecarCarrier } from './round-trip.ts';
import { usageFromIR } from './usage.ts';
import type { IRCollector } from '../../../ir/collector.ts';
import { irPathKey, isIRItemPath, isIRPartPath } from '../../../ir/operation-paths.ts';
import { createIROrdinalMapper } from '../../../ir/ordinal-mapper.ts';
import { consumeIRRecords, type IRPath, type IRRecord } from '../../../ir/stream.ts';
import { IRAbsent, type IR, type IRItem, type IRMessageItem, type IRSourceCitation, type IRTokenLogprob } from '../../../ir/types.ts';
import { createIRUnitQueue, createIRUnitRegistry } from '../../../ir/unit-queue.ts';
import { appendContent, createContentState, type ContentState, type ContentStates } from '../../../round-trip/reference/reference-builder.ts';
import { provenanceSpanForAppend, replayTextProvenance, type TextProvenanceSpan } from '../../../round-trip/reference/text-provenance.ts';
import type { RoundTripOutputOptions } from '../../../round-trip/stream.ts';
import { isCompleteJSONObject, parseJSONObjectAtCompletion } from '../../../shared/json/object.ts';
import { TextCoordinateIndex } from '../../../shared/text-coordinate-index.ts';
import { toOpenAIResponsesInputAssistantTurn, type OpenAIResponsesItemState, type OpenAIResponsesOutputAssistantState } from '../as-target/assistant-turn.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import {
  createRandomOpenAIResponsesItemId,
  type OpenAIResponsesAnnotation,
  type OpenAIResponsesOutputContentBlock,
  type OpenAIResponsesOutputItemEx,
  type OpenAIResponsesOutputRefusal,
  type OpenAIResponsesOutputText,
  type OpenAIResponsesResultEx,
  type OpenAIResponsesStreamEventEx,
} from '@floway-dev/protocols/openai-responses';

interface ResponsesOutputUnitBase {
  readonly path: IRPath;
  readonly parts: IRPath[];
  readonly contentOrdinals: ReturnType<typeof createIROrdinalMapper>;
  readonly annotationProgress: Map<string, { seen: number; emitted: number }>;
  readonly coordinateIndexes: Map<string, TextCoordinateIndex>;
  pendingText?: Map<string, TextProvenanceSpan[]>;
  opened: boolean;
  outputIndex?: number;
  id?: string;
  callId?: string;
  status?: 'completed' | 'incomplete';
  nextPending?: ResponsesOutputUnit;
}

type ResponsesOutputUnit = ResponsesOutputUnitBase & (
  | { readonly kind: 'image' }
  | { readonly kind: 'message'; readonly contentState: ResponsesMessageState }
  | { readonly kind: 'reasoning'; readonly contentState: ResponsesReasoningState }
  | { readonly kind: 'function_call' | 'custom_tool_call'; toolContentState?: ContentState<'text'> }
);

type OpenAIResponsesSSEOutputOptions = RoundTripOutputOptions<'openaiResponses'> & { namespaceToolNames: NamespaceToolNames };

const IMAGE_OUTPUT_FORMATS = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' } as const;

type IRWriteRecord = Extract<IRRecord, { type: 'write' }>;
type IRToolCallItem = Extract<IRItem, { type: 'function_call' | 'custom_tool_call' }>;
// The item an opened unit announces, and the events that bring it up to the content IR already holds.
interface OpenedUnit {
  readonly added: OpenAIResponsesOutputItemEx;
  readonly followUps: OpenAIResponsesStreamEventEx[];
}

type ReasoningField = 'summary' | 'content';
type MessagePart = IRMessageItem['content'][number];

type ResponsesMessageState = OpenAIResponsesItemState<Extract<OpenAIResponsesOutputItemEx, { type: 'message' }>, ContentStates>;
type ResponsesReasoningState = OpenAIResponsesItemState<Extract<OpenAIResponsesOutputItemEx, { type: 'reasoning' }>, ContentStates>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const initializedType = (value: unknown): IRItem['type'] | MessagePart['type'] | undefined => {
  if (!isRecord(value)) return undefined;
  return value.type === 'message'
    || value.type === 'reasoning'
    || value.type === 'function_call'
    || value.type === 'custom_tool_call'
    || value.type === 'text'
    || value.type === 'refusal'
    || value.type === 'image'
    || value.type === 'audio'
    ? value.type
    : undefined;
};

type TextPartLogprobMetadata = { readonly item_index: number; readonly content_index: number };

const textPartLogprobMetadata = (value: unknown): TextPartLogprobMetadata | undefined => {
  if (!isRecord(value) || value.scope !== 'text_part') return undefined;
  return typeof value.item_index === 'number' && typeof value.content_index === 'number'
    ? { item_index: value.item_index, content_index: value.content_index }
    : undefined;
};

const isIRTokenLogprob = (value: unknown): value is IRTokenLogprob =>
  isRecord(value) && typeof value.token === 'string' && typeof value.logprob === 'number';

const reasoningPartAdded = (field: ReasoningField, itemId: string, outputIndex: number, index: number): OpenAIResponsesStreamEventEx =>
  field === 'summary'
    ? {
        type: 'response.reasoning_summary_part.added',
        item_id: itemId,
        output_index: outputIndex,
        summary_index: index,
        part: { type: 'summary_text', text: '' },
      }
    : {
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: outputIndex,
        content_index: index,
        part: { type: 'reasoning_text', text: '' },
      };

const reasoningTextDelta = (field: ReasoningField, itemId: string, outputIndex: number, index: number, delta: string): OpenAIResponsesStreamEventEx =>
  field === 'summary'
    ? {
        type: 'response.reasoning_summary_text.delta',
        item_id: itemId,
        output_index: outputIndex,
        summary_index: index,
        delta,
      }
    : {
        type: 'response.reasoning_text.delta',
        item_id: itemId,
        output_index: outputIndex,
        content_index: index,
        delta,
      };

const reasoningTextDone = (field: ReasoningField, itemId: string, outputIndex: number, index: number, text: string): OpenAIResponsesStreamEventEx =>
  field === 'summary'
    ? {
        type: 'response.reasoning_summary_text.done',
        item_id: itemId,
        output_index: outputIndex,
        summary_index: index,
        text,
      }
    : {
        type: 'response.reasoning_text.done',
        item_id: itemId,
        output_index: outputIndex,
        content_index: index,
        text,
      };

const reasoningPartDone = (field: ReasoningField, itemId: string, outputIndex: number, index: number, text: string): OpenAIResponsesStreamEventEx =>
  field === 'summary'
    ? {
        type: 'response.reasoning_summary_part.done',
        item_id: itemId,
        output_index: outputIndex,
        summary_index: index,
        part: { type: 'summary_text', text },
      }
    : {
        type: 'response.content_part.done',
        item_id: itemId,
        output_index: outputIndex,
        content_index: index,
        part: { type: 'reasoning_text', text },
      };

const emptyContentPart = (type: 'text' | 'refusal'): OpenAIResponsesOutputContentBlock => type === 'text'
  ? { type: 'output_text', text: '', annotations: [], logprobs: [] }
  : { type: 'refusal', refusal: '' };

// The text or refusal part a message unit covers; other part kinds never join a message unit.
const textOrRefusalPart = (state: IR, path: IRPath): Extract<MessagePart, { type: 'text' | 'refusal' }> => {
  const item = state.choices[0].items[path[3] as number];
  if (item.type !== 'message') throw new TypeError('Responses content unit requires a message item');
  const part = item.content[path[5] as number];
  if (part.type !== 'text' && part.type !== 'refusal') throw new TypeError('Responses message output supports only text and refusal parts');
  return part;
};

export const openaiResponsesFromIR = async function* (
  records: AsyncIterable<IRRecord>,
  options: OpenAIResponsesSSEOutputOptions,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  let metadata = { id: '', model: '', created: 0 };
  let started = false;
  let sequence = 0;
  let finishReason: Extract<IRRecord, { type: 'choice_end' }>['finish_reason'] = 'stop';
  const outputUnits: ResponsesOutputUnit[] = [];
  const nativeState: OpenAIResponsesOutputAssistantState<ContentStates> = [];
  const units = createIRUnitRegistry<ResponsesOutputUnit>();
  const messageUnits = new Map<number, ResponsesOutputUnit[]>();
  const logprobGroups = new Map<string, number>();
  const logprobOwners = new Map<number, IRPath>();
  const partTypes = new Map<string, MessagePart['type']>();
  const pendingEnds = new Set<ResponsesOutputUnit>();
  const pending = createIRUnitQueue<ResponsesOutputUnit>();
  let sidecar: OpenAIResponsesOutputItemEx | undefined;
  const emit = (event: OpenAIResponsesStreamEventEx): ProtocolFrame<OpenAIResponsesStreamEventEx> => eventFrame({ ...event, sequence_number: sequence++ });

  const addUnit = (unit: ResponsesOutputUnit): void => {
    pending.enqueue(unit);
    units.set(unit.path, unit);
  };

  const appendUnitText = (unit: ResponsesOutputUnit, path: IRPath, text: string, referencePieceIds?: readonly number[]): void => {
    let content: ContentState<'text'>;
    if (unit.kind === 'message') {
      const index = unit.contentOrdinals.get(path.slice(0, 6));
      const parts = unit.contentState.content ??= [];
      const part = parts[index];
      const refusal = path.at(-1) === 'refusal';
      if (part === undefined) {
        content = createContentState(options.roundTrip.builder, 'text');
        parts[index] = refusal ? { refusal: content } : { text: content };
      } else if (refusal) {
        if (!('refusal' in part) || part.refusal === undefined) throw new Error('Responses refusal state has the wrong kind');
        content = part.refusal;
      } else {
        if (!('text' in part) || part.text === undefined) throw new Error('Responses text state has the wrong kind');
        content = part.text;
      }
    } else if (unit.kind === 'reasoning') {
      const field = path[4];
      const index = path[5];
      if ((field !== 'summary' && field !== 'content') || typeof index !== 'number') throw new Error('Responses reasoning text requires a native part');
      const parts = unit.contentState[field] ??= [];
      const part = parts[index] ??= {};
      content = part.text ??= createContentState(options.roundTrip.builder, 'text');
    } else if (unit.kind === 'function_call' || unit.kind === 'custom_tool_call') {
      if (unit.toolContentState === undefined) throw new Error('Responses tool text requires an opened native field');
      content = unit.toolContentState;
    } else return;
    appendContent(options.roundTrip.builder, content, text, referencePieceIds);
  };

  const appendPendingText = (unit: ResponsesOutputUnit, path: IRPath, text: string): void => {
    const key = irPathKey(path);
    replayTextProvenance(text, unit.pendingText?.get(key) ?? [], (value, referencePieceIds) => appendUnitText(unit, path, value, referencePieceIds));
    unit.pendingText?.delete(key);
  };

  const coordinateIndexFor = (unit: ResponsesOutputUnit, path: IRPath, text: string): TextCoordinateIndex => {
    const key = irPathKey(path);
    let index = unit.coordinateIndexes.get(key);
    if (index === undefined) {
      index = TextCoordinateIndex.utf16ToCodePoints(text);
      unit.coordinateIndexes.set(key, index);
    }
    index.assertUTF16Length(text.length);
    return index;
  };

  const convertAnnotation = (coordinateIndex: () => TextCoordinateIndex, annotation: IRSourceCitation): OpenAIResponsesAnnotation | undefined => {
    if ((annotation.source_kind === 'url' || annotation.source_kind === 'search_result') && annotation.source != null) {
      if (annotation.output_text_range === undefined) return undefined;
      const range = coordinateIndex().irRangeToCodePoints(annotation.output_text_range);
      return {
        type: 'url_citation',
        url: annotation.source,
        title: annotation.source_label ?? annotation.source,
        start_index: range.start,
        end_index: range.end,
      };
    }
    return undefined;
  };

  const convertAnnotations = (
    unit: ResponsesOutputUnit,
    path: IRPath,
    part: Extract<MessagePart, { type: 'text' }>,
    from = 0,
  ): OpenAIResponsesAnnotation[] => (part.annotations ?? []).slice(from).flatMap(annotation => {
    const converted = convertAnnotation(() => coordinateIndexFor(unit, path, part.text), annotation);
    return converted === undefined ? [] : [converted];
  });

  const requireId = (unit: ResponsesOutputUnit): string => {
    if (unit.id === undefined) throw new TypeError('Responses output unit has no item ID');
    return unit.id;
  };

  const requireOutputIndex = (unit: ResponsesOutputUnit): number => {
    if (unit.outputIndex === undefined) throw new TypeError('Responses output unit has no output index');
    return unit.outputIndex;
  };

  const contentPart = (state: IR, unit: ResponsesOutputUnit, path: IRPath): OpenAIResponsesOutputRefusal | Required<OpenAIResponsesOutputText> => {
    const part = textOrRefusalPart(state, path);
    if (part.type === 'refusal') return { type: 'refusal', refusal: part.refusal };
    const logprobGroup = logprobGroups.get(irPathKey(path));
    let logprobs: readonly IRTokenLogprob[] = [];
    if (logprobGroup !== undefined) {
      const group = state.choices[0].logprobs?.[logprobGroup];
      if (group === undefined) throw new TypeError(`Responses logprob group ${logprobGroup} is missing`);
      logprobs = group.tokens;
    }
    return { type: 'output_text', text: part.text, annotations: convertAnnotations(unit, path, part), logprobs: [...logprobs] };
  };

  const outputItem = (state: IR, unit: ResponsesOutputUnit): OpenAIResponsesOutputItemEx => {
    const itemIndex = unit.path[3];
    if (typeof itemIndex !== 'number') throw new TypeError('Responses output unit has no item index');
    const item = state.choices[0].items[itemIndex];
    if (unit.status === undefined) throw new TypeError('Responses output snapshot requires a terminal status');
    const status = unit.status;
    const id = requireId(unit);
    if (unit.kind === 'message') return { type: 'message', id, role: 'assistant', status, content: unit.parts.map(path => contentPart(state, unit, path)) };
    if (unit.kind === 'image') {
      if (item.type !== 'message') throw new TypeError('Responses image unit requires a message item');
      const part = item.content[unit.path[5] as number];
      if (part.type !== 'image') throw new TypeError('Responses image unit requires an image part');
      if (status !== 'completed') throw new TypeError('Responses image unit can only complete');
      const outputFormat = part.image.mime_type === undefined ? undefined : IMAGE_OUTPUT_FORMATS[part.image.mime_type as keyof typeof IMAGE_OUTPUT_FORMATS];
      return { type: 'image_generation_call', id, status, result: part.image.data, ...(outputFormat === undefined ? {} : { output_format: outputFormat }) };
    }
    if (unit.kind === 'reasoning') {
      if (item.type !== 'reasoning') throw new TypeError('Responses reasoning unit requires a reasoning item');
      return {
        type: 'reasoning', id, status,
        summary: (item.summary ?? []).map(text => ({ type: 'summary_text' as const, text })),
        ...(item.content === undefined ? {} : { content: item.content.map(text => ({ type: 'reasoning_text' as const, text })) }),
      };
    }
    if (unit.callId === undefined) throw new TypeError('Responses tool unit has no call ID');
    if (unit.kind === 'custom_tool_call') {
      if (item.type !== 'custom_tool_call') throw new TypeError('Responses tool unit has the wrong IR item');
      return { type: 'custom_tool_call', id, call_id: unit.callId, name: item.name, input: item.input, status };
    }
    if (item.type !== 'function_call') throw new TypeError('Responses tool unit has the wrong IR item');
    return { type: 'function_call', id, call_id: unit.callId, name: item.name, arguments: item.arguments, status };
  };

  const response = (state: IR, status: OpenAIResponsesResultEx['status'], usage: OpenAIResponsesResultEx['usage']): OpenAIResponsesResultEx => ({
    id: metadata.id,
    object: 'response',
    created_at: metadata.created,
    model: metadata.model,
    status,
    output: [...outputUnits.map(unit => outputItem(state, unit)), ...(sidecar === undefined ? [] : [sidecar])],
    usage,
    error: null,
    incomplete_details: status === 'incomplete' ? { reason: finishReason === 'content_filter' ? 'content_filter' : 'max_output_tokens' } : null,
    ...(state.service_tier === undefined ? {} : { service_tier: state.service_tier }),
  });

  // Creates the output units that the IR structures initialized by a record will become.
  const registerUnits = (record: IRRecord, state: IR): void => {
    if (record.type === 'write' && record.kind === 'initialize') {
      if (record.path[0] === 'choices' && record.path[1] !== 0) throw new Error('Responses cannot represent multiple choices');
      if (record.path.length === 4 && record.path[0] === 'choices' && record.path[2] === 'logprobs') {
        const group = textPartLogprobMetadata(record.value);
        if (group !== undefined) {
          const partPath = ['choices', record.path[1], 'items', group.item_index, 'content', group.content_index];
          const groupIndex = record.path[3] as number;
          logprobGroups.set(irPathKey(partPath), groupIndex);
          logprobOwners.set(groupIndex, partPath);
        }
      } else if (isIRItemPath(record.path, state)) {
        const type = initializedType(record.value);
        if (type === 'reasoning' || type === 'function_call' || type === 'custom_tool_call') {
          const unit: ResponsesOutputUnitBase = {
            path: record.path,
            parts: [],
            contentOrdinals: createIROrdinalMapper(),
            annotationProgress: new Map(),
            coordinateIndexes: new Map(),
            opened: false,
          };
          if (type === 'reasoning') addUnit({ ...unit, kind: type, contentState: {} });
          else addUnit({ ...unit, kind: type });
        }
      } else if (isIRPartPath(record.path, state)) {
        const itemIndex = record.path[3] as number;
        const type = initializedType(record.value);
        if (type === undefined || type === 'message' || type === 'reasoning' || type === 'function_call' || type === 'custom_tool_call') {
          throw new TypeError('Responses part initialization requires a content part');
        }
        partTypes.set(irPathKey(record.path), type);
        if (type === 'text' || type === 'refusal') {
          let itemUnits = messageUnits.get(itemIndex);
          if (itemUnits === undefined) { itemUnits = []; messageUnits.set(itemIndex, itemUnits); }
          let unit = itemUnits.at(-1);
          const previousPath: IRPath = ['choices', record.path[1], 'items', itemIndex, 'content', (record.path[5] as number) - 1];
          const previousType = (record.path[5] as number) > 0 ? partTypes.get(irPathKey(previousPath)) : undefined;
          if (unit === undefined || (previousType !== 'text' && previousType !== 'refusal')) {
            unit = {
              path: record.path,
              kind: 'message',
              parts: [],
              contentOrdinals: createIROrdinalMapper(),
              annotationProgress: new Map(),
              coordinateIndexes: new Map(),
              contentState: {},
              opened: false,
            };
            itemUnits.push(unit);
            addUnit(unit);
          }
          unit.parts.push(record.path);
          units.set(record.path, unit);
        } else if (type === 'image') {
          addUnit({
            path: record.path,
            kind: 'image',
            parts: [record.path],
            contentOrdinals: createIROrdinalMapper(),
            annotationProgress: new Map(),
            coordinateIndexes: new Map(),
            opened: false,
          });
        }
      }
    }
  };

  const openMessageUnit = (unit: ResponsesOutputUnit, state: IR, outputIndex: number): OpenedUnit => {
    const id = createRandomOpenAIResponsesItemId('message');
    unit.id = id;
    const followUps: OpenAIResponsesStreamEventEx[] = [];
    for (const partPath of unit.parts) {
      const part = textOrRefusalPart(state, partPath);
      const contentIndex = unit.contentOrdinals.open(partPath);
      appendPendingText(unit, [...partPath, part.type === 'text' ? 'text' : 'refusal'], part.type === 'text' ? part.text : part.refusal);
      followUps.push({
        type: 'response.content_part.added',
        item_id: id,
        output_index: outputIndex,
        content_index: contentIndex,
        part: emptyContentPart(part.type),
      });
      if (part.type === 'text') {
        if (part.text !== '') {
          followUps.push({
            type: 'response.output_text.delta',
            item_id: id,
            output_index: outputIndex,
            content_index: contentIndex,
            delta: part.text,
            logprobs: [],
          });
        }
        const annotations = convertAnnotations(unit, partPath, part);
        annotations.forEach((annotation, annotationIndex) => {
          followUps.push({
            type: 'response.output_text.annotation.added',
            item_id: id,
            output_index: outputIndex,
            content_index: contentIndex,
            annotation_index: annotationIndex,
            annotation,
          });
        });
        unit.annotationProgress.set(irPathKey(partPath), { seen: part.annotations?.length ?? 0, emitted: annotations.length });
      } else if (part.refusal !== '') {
        followUps.push({ type: 'response.refusal.delta', item_id: id, output_index: outputIndex, content_index: contentIndex, delta: part.refusal });
      }
    }
    return { added: { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] }, followUps };
  };

  const openImageUnit = (unit: ResponsesOutputUnit): OpenedUnit => {
    const id = createRandomOpenAIResponsesItemId('image_generation_call');
    unit.id = id;
    return { added: { type: 'image_generation_call', id, status: 'in_progress', result: null }, followUps: [] };
  };

  const openReasoningUnit = (unit: ResponsesOutputUnit, item: IRItem, outputIndex: number): OpenedUnit => {
    const reasoning = item.type === 'reasoning' ? item : undefined;
    const id = createRandomOpenAIResponsesItemId('reasoning');
    unit.id = id;
    const followUps: OpenAIResponsesStreamEventEx[] = [];
    for (const field of ['summary', 'content'] as const) (reasoning?.[field] ?? []).forEach((text, part) => {
      appendPendingText(unit, [...unit.path, field, part], text);
      followUps.push(reasoningPartAdded(field, id, outputIndex, part));
      if (text !== '') followUps.push(reasoningTextDelta(field, id, outputIndex, part, text));
    });
    return { added: { type: 'reasoning', id, status: 'in_progress', summary: [], ...(reasoning?.content === undefined ? {} : { content: [] }) }, followUps };
  };

  const openToolUnit = (unit: ResponsesOutputUnit, item: IRToolCallItem, callId: string | typeof IRAbsent, outputIndex: number): OpenedUnit => {
    if (unit.kind !== 'function_call' && unit.kind !== 'custom_tool_call') throw new Error('Responses tool opening requires a tool unit');
    const custom = unit.kind === 'custom_tool_call';
    const id = createRandomOpenAIResponsesItemId(custom ? 'custom_tool_call' : 'function_call');
    const resolvedCallId = callId === IRAbsent ? createRandomOpenAIResponsesItemId('function_call') : callId;
    unit.id = id;
    unit.callId = resolvedCallId;
    const added: OpenAIResponsesOutputItemEx = custom
      ? { type: 'custom_tool_call', id, call_id: resolvedCallId, name: item.name, input: '', status: 'in_progress' }
      : { type: 'function_call', id, call_id: resolvedCallId, name: item.name, arguments: '', status: 'in_progress' };
    const restored = restoreNamespaceOutputItem(added, options.namespaceToolNames, 'in_progress');
    const content = createContentState(options.roundTrip.builder, 'text');
    unit.toolContentState = content;
    nativeState[outputIndex] = restored.type === 'custom_tool_call' ? { input: content } : { arguments: content };
    const followUps: OpenAIResponsesStreamEventEx[] = [];
    appendPendingText(unit, [...unit.path, item.type === 'custom_tool_call' ? 'input' : 'arguments'], item.type === 'custom_tool_call' ? item.input : item.arguments);
    if (item.type === 'custom_tool_call') {
      if (item.input !== '') followUps.push({ type: 'response.custom_tool_call_input.delta', item_id: id, output_index: outputIndex, delta: item.input });
    } else if (item.arguments !== '') {
      followUps.push({ type: 'response.function_call_arguments.delta', item_id: id, output_index: outputIndex, delta: item.arguments });
    }
    return { added, followUps };
  };

  // Opens the waiting units in IR order, until one still lacks what its opening event needs.
  const openPendingUnits = (state: IR, collector: IRCollector): { events: OpenAIResponsesStreamEventEx[]; justOpened: Set<string> } => {
    const justOpened = new Set<string>();
    const pendingEvents: OpenAIResponsesStreamEventEx[] = [];
    while (pending.head !== undefined) {
      const unit = pending.head;
      const item = state.choices[0].items[unit.path[3] as number];
      let tool: { item: IRToolCallItem; callId: string | typeof IRAbsent } | undefined;
      if (unit.kind === 'function_call' || unit.kind === 'custom_tool_call') {
        if ((item.type !== 'function_call' && item.type !== 'custom_tool_call') || item.name === '') throw new TypeError('Completed tool calls require a name');
        const callId = collector.optional<string>([...unit.path, 'call_id']);
        if (callId === undefined) break;
        tool = { item, callId };
      }
      pending.dequeue();
      const outputIndex = outputUnits.length;
      unit.outputIndex = outputIndex;
      if (unit.kind === 'message' || unit.kind === 'reasoning') nativeState[outputIndex] = unit.contentState;
      const { added, followUps } = tool !== undefined ? openToolUnit(unit, tool.item, tool.callId, outputIndex)
        : unit.kind === 'message' ? openMessageUnit(unit, state, outputIndex)
          : unit.kind === 'image' ? openImageUnit(unit)
            : openReasoningUnit(unit, item, outputIndex);
      unit.opened = true;
      outputUnits.push(unit);
      pendingEvents.push({ type: 'response.output_item.added', output_index: outputIndex, item: added }, ...followUps);
      justOpened.add(irPathKey(unit.path));
    }
    return { events: pendingEvents, justOpened };
  };

  const messageUnitEvents = (unit: ResponsesOutputUnit, outputIndex: number, record: IRWriteRecord, state: IR): OpenAIResponsesStreamEventEx[] => {
    const itemId = requireId(unit);
    if (record.kind === 'initialize' && record.path.length === 6) {
      const type = initializedType(record.value);
      if (type !== 'text' && type !== 'refusal') throw new TypeError('Responses message output supports only text and refusal parts');
      const contentIndex = unit.contentOrdinals.open(record.path);
      return [{
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        part: emptyContentPart(type),
      }];
    }
    if (record.kind === 'append') {
      const partPath = record.path.slice(0, 6);
      const contentIndex = unit.contentOrdinals.get(partPath);
      if (record.path.at(-1) !== 'refusal') unit.coordinateIndexes.get(irPathKey(partPath))?.append(record.value);
      return record.path.at(-1) === 'refusal'
        ? [{ type: 'response.refusal.delta', item_id: itemId, output_index: outputIndex, content_index: contentIndex, delta: record.value }]
        : [{ type: 'response.output_text.delta', item_id: itemId, output_index: outputIndex, content_index: contentIndex, delta: record.value, logprobs: [] }];
    }
    if (record.kind === 'assign' && record.path[6] === 'annotations') {
      const partPath = record.path.slice(0, 6);
      const contentIndex = unit.contentOrdinals.get(partPath);
      const part = textOrRefusalPart(state, partPath);
      const key = irPathKey(partPath);
      const progress = unit.annotationProgress.get(key) ?? { seen: 0, emitted: 0 };
      const converted = part.type === 'text' ? convertAnnotations(unit, partPath, part, progress.seen) : [];
      unit.annotationProgress.set(key, {
        seen: part.type === 'text' ? part.annotations?.length ?? 0 : 0,
        emitted: progress.emitted + converted.length,
      });
      return converted.map((annotation, offset): OpenAIResponsesStreamEventEx => ({
        type: 'response.output_text.annotation.added',
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        annotation_index: progress.emitted + offset,
        annotation,
      }));
    }
    return [];
  };

  const reasoningUnitEvents = (unit: ResponsesOutputUnit, outputIndex: number, record: IRWriteRecord): OpenAIResponsesStreamEventEx[] => {
    const field = record.path[4];
    const contentIndex = record.path[5];
    if ((field !== 'summary' && field !== 'content') || typeof contentIndex !== 'number') return [];
    if (record.kind === 'initialize' && record.path.length === 6 && (field === 'summary' || field === 'content')) {
      return [reasoningPartAdded(field, requireId(unit), outputIndex, contentIndex)];
    }
    if (record.kind === 'append') {
      return [reasoningTextDelta(field, requireId(unit), outputIndex, contentIndex, record.value)];
    }
    return [];
  };

  const toolUnitEvents = (unit: ResponsesOutputUnit, outputIndex: number, record: IRWriteRecord): OpenAIResponsesStreamEventEx[] => {
    if (record.kind !== 'append') return [];
    return [{
      type: unit.kind === 'custom_tool_call' ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta',
      item_id: requireId(unit),
      output_index: outputIndex,
      delta: record.value,
    }];
  };

  // The events for an operation on a unit that is already open.
  const openedUnitEvents = (unit: ResponsesOutputUnit, record: IRWriteRecord, state: IR): OpenAIResponsesStreamEventEx[] => {
    const outputIndex = requireOutputIndex(unit);
    switch (unit.kind) {
    case 'message': return messageUnitEvents(unit, outputIndex, record, state);
    case 'reasoning': return reasoningUnitEvents(unit, outputIndex, record);
    case 'function_call':
    case 'custom_tool_call': return toolUnitEvents(unit, outputIndex, record);
    case 'image': return [];
    }
  };

  for await (const { record, collector } of consumeIRRecords(records)) {
    const { state } = collector;
    if (record.type === 'error') {
      yield emit({
        type: 'error',
        message: record.error.message,
        code: record.error.code ?? record.error.type,
        ...(record.error.param === undefined ? {} : { param: record.error.param }),
      });
      return;
    }
    if (record.type === 'write' && record.path[0] === 'model' && typeof record.value === 'string') metadata.model = record.value;
    if (record.type === 'start') {
      if (state.model === undefined) throw new TypeError('Responses output requires an IR model before start');
      const id = options.id ?? record.id;
      metadata = {
        id: id?.startsWith('resp_') ? id : createRandomOpenAIResponsesResponseId(),
        model: state.model,
        created: record.created ?? options.created ?? Math.floor(Date.now() / 1000),
      };
      const initialUsage = state.usage === undefined ? null : usageFromIR(state.usage);
      yield emit({ type: 'response.created', response: response(state, 'in_progress', initialUsage) });
      yield emit({ type: 'response.in_progress', response: response(state, 'in_progress', initialUsage) });
      started = true;
      continue;
    }
    if (!started) continue;
    if (record.type === 'choice_end') {
      if (record.choice !== 0) throw new Error('Responses cannot represent multiple choices');
      finishReason = record.finish_reason;
      for (const current of pendingEnds) {
        const item = state.choices[0].items[current.path[3] as number];
        if (item.type !== 'function_call') throw new TypeError('Responses pending function unit requires a function item');
        const outputIndex = requireOutputIndex(current);
        parseJSONObjectAtCompletion(item.arguments, finishReason === 'length' ? 'truncated' : 'complete');
        yield emit({
          type: 'response.function_call_arguments.done',
          item_id: requireId(current),
          output_index: outputIndex,
          arguments: item.arguments,
          name: item.name,
        });
        current.status = finishReason === 'length' ? 'incomplete' : 'completed';
        yield emit({ type: 'response.output_item.done', output_index: outputIndex, item: outputItem(state, current) });
        units.delete(current.path);
        pendingEnds.delete(current);
      }
      continue;
    }

    registerUnits(record, state);
    const unit = units.forRecord(record, state);
    if (unit !== undefined && unit.kind !== 'image' && record.type === 'write' && record.kind === 'append') {
      if (unit.opened) appendUnitText(unit, record.path, record.value, record.referencePieceIds);
      else {
        const text = collector.value<string>(record.path);
        if (text === undefined) throw new Error('Missing Responses pending text');
        const fields = unit.pendingText ??= new Map();
        const key = irPathKey(record.path);
        const atoms = fields.get(key) ?? [];
        atoms.push(provenanceSpanForAppend(text, record.value, record.referencePieceIds));
        fields.set(key, atoms);
      }
    }
    const { events: pendingEvents, justOpened } = openPendingUnits(state, collector);
    for (const event of pendingEvents) yield emit(event);

    if (unit?.opened && !justOpened.has(irPathKey(unit.path)) && record.type === 'write') {
      for (const event of openedUnitEvents(unit, record, state)) yield emit(event);
    }

    if (record.type === 'write'
      && record.kind === 'assign'
      && record.path[0] === 'choices'
      && record.path[2] === 'logprobs'
      && record.path[4] === 'tokens'
      && typeof record.path[5] === 'number') {
      const partPath = logprobOwners.get(record.path[3] as number);
      if (partPath !== undefined) {
        const owner = units.get(partPath);
        if (owner?.opened && owner.kind === 'message') {
          if (!isIRTokenLogprob(record.value)) throw new TypeError('Responses logprob token requires a token');
          const outputIndex = requireOutputIndex(owner);
          const contentIndex = owner.contentOrdinals.get(partPath);
          yield emit({
            type: 'response.output_text.delta',
            item_id: requireId(owner),
            output_index: outputIndex,
            content_index: contentIndex,
            delta: '',
            logprobs: [record.value],
          });
        }
      }
    }

    if (record.type === 'part_end') {
      const partPath: IRPath = ['choices', record.choice, 'items', record.item, 'content', record.part];
      const item = state.choices[record.choice].items[record.item];
      const part = item.type === 'message' ? item.content[record.part] : undefined;
      if (part?.type === 'audio') {
        if (part.audio.data !== undefined) yield emit({ type: 'response.audio.done' });
        if (part.audio.transcript !== undefined) yield emit({ type: 'response.audio.transcript.done' });
      } else if (unit?.opened && unit.kind === 'message') {
        const outputIndex = requireOutputIndex(unit);
        const contentIndex = unit.contentOrdinals.get(partPath);
        const nativePart = contentPart(state, unit, partPath);
        if (nativePart.type === 'refusal') {
          yield emit({
            type: 'response.refusal.done',
            item_id: requireId(unit),
            output_index: outputIndex,
            content_index: contentIndex,
            refusal: nativePart.refusal,
          });
        } else {
          yield emit({
            type: 'response.output_text.done',
            item_id: requireId(unit),
            output_index: outputIndex,
            content_index: contentIndex,
            text: nativePart.text,
            logprobs: [...nativePart.logprobs],
          });
        }
        yield emit({ type: 'response.content_part.done', item_id: requireId(unit), output_index: outputIndex, content_index: contentIndex, part: nativePart });
        unit.contentOrdinals.close(partPath);
      } else if (unit?.opened && unit.kind === 'image') {
        const outputIndex = requireOutputIndex(unit);
        if (part?.type !== 'image') throw new TypeError('Responses image unit requires an image part');
        unit.status = 'completed';
        yield emit({ type: 'response.output_item.done', output_index: outputIndex, item: outputItem(state, unit) });
        units.delete(unit.path);
      }
    }

    if (record.type === 'item_end') {
      const item = state.choices[record.choice].items[record.item];
      const closing = item.type === 'message' ? messageUnits.get(record.item) ?? [] : unit === undefined ? [] : [unit];
      for (const current of closing) if (current.opened && current.kind !== 'image') {
        const outputIndex = requireOutputIndex(current);
        if (current.kind === 'function_call' && item.type === 'function_call' && record.status === undefined && !isCompleteJSONObject(item.arguments)) {
          pendingEnds.add(current);
          continue;
        }
        if (current.kind === 'reasoning') {
          if (item.type !== 'reasoning') throw new TypeError('Responses reasoning unit requires a reasoning item');
          for (const field of ['summary', 'content'] as const) for (let part = 0; part < (item[field]?.length ?? 0); part++) {
            const contentIndex = part;
            const text = item[field]![contentIndex];
            yield emit(reasoningTextDone(field, requireId(current), outputIndex, contentIndex, text));
            yield emit(reasoningPartDone(field, requireId(current), outputIndex, contentIndex, text));
          }
        } else if (current.kind === 'custom_tool_call') {
          if (item.type !== 'custom_tool_call') throw new TypeError('Responses tool unit has the wrong IR item');
          yield emit({
            type: 'response.custom_tool_call_input.done',
            item_id: requireId(current),
            output_index: outputIndex,
            input: item.input,
          });
        } else if (current.kind === 'function_call') {
          if (item.type !== 'function_call') throw new TypeError('Responses tool unit has the wrong IR item');
          yield emit({
            type: 'response.function_call_arguments.done',
            item_id: requireId(current),
            output_index: outputIndex,
            arguments: item.arguments,
            name: item.name,
          });
        }
        current.status = record.status === 'incomplete' ? 'incomplete' : 'completed';
        yield emit({ type: 'response.output_item.done', output_index: outputIndex, item: outputItem(state, current) });
        units.delete(current.path);
        for (const part of current.parts) units.delete(part);
      }
      messageUnits.delete(record.item);
    }

    if (record.type === 'write'
      && record.kind === 'append'
      && record.path.length === 8
      && record.path[4] === 'content'
      && record.path[6] === 'audio') {
      yield emit({ type: record.path[7] === 'data' ? 'response.audio.delta' : 'response.audio.transcript.delta', delta: record.value });
    }

    if (record.type === 'finish') {
      const refusal = state.choices[0].refusal;
      const finalUsage = state.usage === undefined ? null : usageFromIR(state.usage);
      if (refusal?.category === 'cyber' || refusal?.category === 'bio') {
        const declined = refusal.explanation == null || refusal.explanation.trim() === '';
        const message = declined ? `The upstream declined this request under the ${refusal.category} policy category.` : refusal.explanation;
        yield emit({ type: 'response.failed', response: { ...response(state, 'failed', finalUsage), error: { code: `${refusal.category}_policy`, message } } });
        return;
      }
      const status = record.status === 'completed' && finishReason === 'content_filter' ? 'incomplete' : record.status;
      const nativeOutput = outputUnits.map(unit => restoreNamespaceOutputItem(outputItem(state, unit), options.namespaceToolNames, 'completed'));
      nativeState.length = nativeOutput.length;
      const sourceTurnDigest = await computeOpenAIResponsesTurnDigest(nativeOutput);
      const input = toOpenAIResponsesInputAssistantTurn<ContentStates>(nativeOutput, nativeState);
      const data = await options.roundTrip.prepareSidecar(0, sourceTurnDigest, input.turn, input.state, collectOpenAIResponsesTextViews(input.turn));
      sidecar = { ...createOpenAIResponsesSidecarCarrier(createRandomOpenAIResponsesItemId('reasoning'), data), status: 'completed' };
      const outputIndex = outputUnits.length;
      yield emit({ type: 'response.output_item.added', output_index: outputIndex, item: sidecar });
      yield emit({ type: 'response.output_item.done', output_index: outputIndex, item: sidecar });
      yield emit({ type: `response.${status}`, response: response(state, status, finalUsage) });
    }
  }
};
