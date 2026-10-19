import { collectGeminiGenerateContentTextViews, computeGeminiGenerateContentTurnDigest, createGeminiGenerateContentSidecarCarrier } from './round-trip.ts';
import { usageFromIR } from './usage.ts';
import type { IRCollector } from '../../../ir/collector.ts';
import { irItemPath, irPartPath, irPathKey, isIRItemPath, isIRPartPath } from '../../../ir/operation-paths.ts';
import { consumeIRRecords, type IRPath, type IRRecord } from '../../../ir/stream.ts';
import { IRAbsent, type IR, type IRErrorPayload, type IRJSONObject, type IRSourceCitation, type IRTokenLogprob } from '../../../ir/types.ts';
import { createIRUnitQueue, createIRUnitRegistry, type IRUnitQueue } from '../../../ir/unit-queue.ts';
import { appendContent, createContentState, type ContentStates, type ContentState as ReferenceContentState } from '../../../round-trip/reference/reference-builder.ts';
import { provenanceSpanForAppend, replayTextProvenance, type TextProvenanceSpan } from '../../../round-trip/reference/text-provenance.ts';
import type { RoundTripOutputOptions } from '../../../round-trip/stream.ts';
import { isContextExceededError } from '../../../shared/context-window-error.ts';
import { isCompleteJSONObject, parseJSONObjectAtCompletion } from '../../../shared/json/object.ts';
import { TextCoordinateIndex } from '../../../shared/text-coordinate-index.ts';
import type { GeminiGenerateContentAssistantState, GeminiGenerateContentInputAssistantTurn } from '../as-target/assistant-turn.ts';
import { eventFrame, FAST_SERVICE_TIER, type EventFrame } from '@floway-dev/protocols/common';
import {
  type GeminiGenerateContentCandidate,
  type GeminiGenerateContentErrorResponse,
  type GeminiGenerateContentGroundingChunk,
  type GeminiGenerateContentPart,
  type GeminiGenerateContentResult,
  type GeminiGenerateContentStreamEvent,
  createGeminiGenerateContentEventAccumulator,
} from '@floway-dev/protocols/gemini-generate-content';

const irGenerateContentError = (error: IRErrorPayload): GeminiGenerateContentErrorResponse['error'] => {
  const code = error.code ?? error.type;
  const [status, statusCode] = code === 'rate_limit_exceeded' || code === 'rate_limit_error' ? ['RESOURCE_EXHAUSTED', 429]
    : code === 'invalid_prompt' || code === 'invalid_request_error' || isContextExceededError(error) ? ['INVALID_ARGUMENT', 400]
      : code === 'overloaded_error' ? ['UNAVAILABLE', 503] : ['INTERNAL', 500];
  return { code: statusCode, status, message: error.message };
};

interface GenerateContentUnit {
  readonly path: IRPath;
  readonly kind: 'text' | 'refusal' | 'audio' | 'image' | 'reasoning' | 'function_call';
  opened: boolean;
  pendingData?: TextProvenanceSpan[];
  pendingArguments?: TextProvenanceSpan[];
  nextPending?: GenerateContentUnit;
}

interface PendingTextQueue {
  values: { unit: GenerateContentUnit; source: IRPath; span: TextProvenanceSpan; thought: boolean }[];
  head: number;
}

interface TextSegment {
  source: IRPath;
  sourceStart: number;
  sourceEnd: number;
  partIndex: number;
  targetStart: number;
}

interface GeminiGenerateContentSSEOutputOptions extends RoundTripOutputOptions<'geminiGenerateContent'> {
  parseToolArguments?: (text: string) => IRJSONObject;
}

export const geminiGenerateContentFromIR = async function* (
  records: AsyncIterable<IRRecord>,
  options: GeminiGenerateContentSSEOutputOptions,
): AsyncGenerator<EventFrame<GeminiGenerateContentStreamEvent>> {
  let metadata = { id: '', model: '' };
  let started = false;
  const queues = new Map<number, IRUnitQueue<GenerateContentUnit>>();
  const units = createIRUnitRegistry<GenerateContentUnit>();
  const nextPartIndices = new Map<number, number>();
  const lastKinds = new Map<number, 'text' | 'thought' | 'other'>();
  const mappings = new Map<string, TextSegment[]>();
  const segmentsByChoice = new Map<number, Map<number, TextSegment[]>>();
  const pendingText = new Map<number, PendingTextQueue>();
  const sourceLengths = new Map<string, number>();
  const nativeAccumulator = createGeminiGenerateContentEventAccumulator();
  type ContentState = NonNullable<GeminiGenerateContentAssistantState<ContentStates>[number]>;
  type PartsState = NonNullable<ContentState['parts']>;
  const partStates = new Map<number, PartsState>();

  const partsState = (choice: number): PartsState => {
    let state = partStates.get(choice);
    if (state === undefined) { state = []; partStates.set(choice, state); }
    return state;
  };

  const appendPendingContent = (content: ReferenceContentState, text: string, spans: readonly TextProvenanceSpan[]): void =>
    replayTextProvenance(text, spans, (value, referencePieceIds) => appendContent(options.roundTrip.builder, content, value, referencePieceIds));

  const emit = (event: GeminiGenerateContentResult): EventFrame<GeminiGenerateContentStreamEvent> => {
    const frame = eventFrame({ responseId: metadata.id, modelVersion: metadata.model, ...event });
    nativeAccumulator.accept(frame.event);
    return frame;
  };
  const emitPart = (choice: number, part: GeminiGenerateContentPart): EventFrame<GeminiGenerateContentStreamEvent> =>
    emit({ candidates: [{ index: choice, content: { role: 'model', parts: [part] } }] });
  const addUnit = (choice: number, unit: GenerateContentUnit): void => {
    let queue = queues.get(choice);
    if (queue === undefined) { queue = createIRUnitQueue(); queues.set(choice, queue); }
    queue.enqueue(unit);
    units.set(unit.path, unit);
  };

  const occupyPart = (choice: number, kind: 'text' | 'thought' | 'other'): number => {
    const next = nextPartIndices.get(choice) ?? 0;
    if (kind === 'text' && lastKinds.get(choice) === 'text') return next - 1;
    nextPartIndices.set(choice, next + 1);
    lastKinds.set(choice, kind);
    return next;
  };

  const appendText = (choice: number, source: IRPath, text: string, thought: boolean, referencePieceIds?: readonly number[]): GeminiGenerateContentPart | undefined => {
    if (text === '') return undefined;
    const kind = thought ? 'thought' : 'text';
    const partIndex = occupyPart(choice, kind);
    let byPart = segmentsByChoice.get(choice);
    if (byPart === undefined) { byPart = new Map(); segmentsByChoice.set(choice, byPart); }
    const partSegments = byPart.get(partIndex) ?? [];
    const lastPartSegment = partSegments.at(-1);
    const targetStart = lastPartSegment === undefined ? 0 : lastPartSegment.targetStart + lastPartSegment.sourceEnd - lastPartSegment.sourceStart;
    const segments = mappings.get(irPathKey(source)) ?? [];
    const previous = segments.at(-1);
    const sourceEnd = previous === undefined ? text.length : previous.sourceEnd + text.length;
    const sourceStart = sourceEnd - text.length;
    const continuesPrevious = previous?.partIndex === partIndex
      && previous.sourceEnd === sourceStart
      && previous.targetStart + previous.sourceEnd - previous.sourceStart === targetStart;
    if (continuesPrevious) previous.sourceEnd = sourceEnd;
    else {
      const segment = { source, sourceStart, sourceEnd, partIndex, targetStart };
      segments.push(segment);
      partSegments.push(segment);
      byPart.set(partIndex, partSegments);
    }
    mappings.set(irPathKey(source), segments);
    if (!thought) {
      const state = partsState(choice);
      const partState = state[partIndex];
      const existing = partState !== undefined && 'text' in partState ? partState.text : undefined;
      const content = existing ?? createContentState(options.roundTrip.builder, 'text');
      if (existing === undefined) state[partIndex] = { text: content };
      appendContent(options.roundTrip.builder, content, text, referencePieceIds);
    }
    return { text, ...(thought ? { thought: true } : {}) };
  };

  const textAppendKind = (unit: GenerateContentUnit, path: IRPath): 'text' | 'thought' | undefined =>
    unit.kind === 'reasoning' ? 'thought'
      : unit.kind === 'text' || unit.kind === 'refusal' || unit.kind === 'audio' && path.at(-1) === 'transcript' ? 'text' : undefined;

  const takePendingText = (choice: number, unit: GenerateContentUnit): PendingTextQueue['values'] => {
    const queue = pendingText.get(choice);
    if (queue === undefined) return [];
    const taken = queue.values.slice(queue.head).filter(value => value.unit === unit);
    queue.values = [...queue.values.slice(0, queue.head), ...queue.values.slice(queue.head).filter(value => value.unit !== unit)];
    if (queue.head === queue.values.length) pendingText.delete(choice);
    return taken;
  };

  const drainPendingText = (choice: number, collector: IRCollector): GeminiGenerateContentPart[] => {
    const queue = pendingText.get(choice);
    if (queue === undefined) return [];
    const parts: GeminiGenerateContentPart[] = [];
    while (queue.head < queue.values.length && queue.values[queue.head].unit.opened) {
      const pending = queue.values[queue.head++];
      const source = collector.value<string>(pending.source);
      if (source === undefined) throw new TypeError(`GenerateContent pending text source is missing: ${JSON.stringify(pending.source)}`);
      const part = appendText(choice, pending.source, source.slice(pending.span.start, pending.span.endExclusive), pending.thought, pending.span.referencePieceIds);
      if (part !== undefined) parts.push(part);
    }
    if (queue.head === queue.values.length) pendingText.delete(choice);
    return parts;
  };

  const initializedType = (value: unknown): GenerateContentUnit['kind'] | 'message' | 'custom_tool_call' | undefined => {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || !('type' in value)) return undefined;
    const { type } = value;
    return type === 'text'
      || type === 'refusal'
      || type === 'audio'
      || type === 'image'
      || type === 'reasoning'
      || type === 'function_call'
      || type === 'message'
      || type === 'custom_tool_call'
      ? type
      : undefined;
  };

  // Queues the units that the IR structures initialized by a record will become.
  const registerUnits = (record: IRRecord, state: IR): void => {
    if (record.type === 'write' && record.kind === 'initialize') {
      const choice = record.path[1];
      if (typeof choice !== 'number') return;
      if (isIRItemPath(record.path, state)) {
        const type = initializedType(record.value);
        if (type === 'custom_tool_call') throw new TypeError('GenerateContent cannot represent custom tool calls');
        if (type === 'reasoning' || type === 'function_call') {
          addUnit(choice, { path: record.path, kind: type, opened: false });
        }
      } else if (isIRPartPath(record.path, state)) {
        const type = initializedType(record.value);
        if (type === 'text' || type === 'refusal' || type === 'audio' || type === 'image') {
          addUnit(choice, { path: record.path, kind: type, opened: false });
        }
      }
    }
  };

  // Opens each choice's waiting units in IR order, until one still lacks what its part needs.
  const openPendingUnits = function* (record: IRRecord, state: IR, collector: IRCollector): Generator<EventFrame<GeminiGenerateContentStreamEvent>> {
    const endingChoice = record.type === 'choice_end' ? record : undefined;
    for (const [choice, queue] of queues) {
      const choiceEnding = endingChoice?.choice === choice ? endingChoice : undefined;
      while (queue.head !== undefined) {
        const unit = queue.head;
        const item = state.choices[choice].items[unit.path[3] as number];
        const closed = !collector.isOpen(unit.path);
        let wait = false;
        let part: GeminiGenerateContentPart | undefined;
        if (unit.kind === 'text' || unit.kind === 'refusal' || unit.kind === 'audio' || unit.kind === 'image') {
          if (item.type !== 'message') throw new TypeError('GenerateContent message unit requires a message item');
          const content = item.content[unit.path[5] as number];
          const inlineMedia = content.type === 'image'
            ? { mimeType: content.image.mime_type, data: content.image.data }
            : content.type === 'audio' && content.audio.data !== undefined
              ? { mimeType: content.audio.mime_type, data: content.audio.data }
              : undefined;
          if (content.type === 'text' || content.type === 'refusal') {
            part = undefined;
          } else if (!closed) wait = true;
          else if (inlineMedia !== undefined) {
            const mime = inlineMedia.mimeType;
            if (mime === undefined) throw new TypeError('GenerateContent inline data requires a MIME type');
            part = {
              inlineData: { mimeType: mime, data: inlineMedia.data },
              ...(content.type === 'audio' && content.audio.transcript !== undefined ? { audioTranscription: { text: content.audio.transcript } } : {}),
            };
            const transcriptAtoms = content.type === 'audio' ? takePendingText(choice, unit) : [];
            const partIndex = occupyPart(choice, 'other');
            const dataState = createContentState(options.roundTrip.builder, 'text');
            appendPendingContent(dataState, inlineMedia.data, unit.pendingData ?? []);
            let transcriptState: ReferenceContentState<'text'> | undefined;
            if (content.type === 'audio' && content.audio.transcript !== undefined) {
              transcriptState = createContentState(options.roundTrip.builder, 'text');
              appendPendingContent(transcriptState, content.audio.transcript, transcriptAtoms.map(atom => atom.span));
            }
            partsState(choice)[partIndex] = {
              inlineData: { data: dataState },
              ...(transcriptState === undefined ? {} : { audioTranscription: { text: transcriptState } }),
            };
          } else if (content.type === 'audio' && content.audio.transcript !== undefined) part = undefined;
        } else if (unit.kind === 'reasoning') {
          if (item.type !== 'reasoning') throw new TypeError('GenerateContent reasoning unit requires a reasoning item');
          if (item.summary !== undefined || item.content !== undefined) {
            part = undefined;
          } else if (!closed) wait = true;
        } else if (unit.kind === 'function_call') {
          if (!closed) wait = true;
          else {
            if (item.type !== 'function_call') throw new TypeError('GenerateContent function unit requires a function item');
            const completion = record.type === 'item_end'
              && record.choice === choice
              && record.item === unit.path[3]
              && record.status === 'incomplete'
              || choiceEnding?.finish_reason === 'length'
              ? 'truncated'
              : 'complete';
            if (completion === 'truncated') part = undefined;
            else if (!isCompleteJSONObject(item.arguments) && choiceEnding === undefined && record.type !== 'finish') wait = true;
            else {
              const parsed = parseJSONObjectAtCompletion(item.arguments, completion, options.parseToolArguments);
              if (parsed.completion === 'complete') {
                const partIndex = occupyPart(choice, 'other');
                part = {
                  functionCall: {
                    name: item.name,
                    ...(item.call_id === undefined || item.call_id === IRAbsent ? {} : { id: item.call_id }),
                    args: parsed.value,
                  },
                };
                const argumentState = createContentState(options.roundTrip.builder, 'json');
                const serialized = JSON.stringify(parsed.value);
                if (serialized === item.arguments) appendPendingContent(argumentState, serialized, unit.pendingArguments ?? []);
                else appendContent(options.roundTrip.builder, argumentState, serialized);
                partsState(choice)[partIndex] = { functionCall: { args: argumentState } };
              }
            }
          }
        }
        if (wait) break;
        queue.dequeue();
        unit.opened = true;
        if (part !== undefined) yield emitPart(choice, part);
        for (const pendingPart of drainPendingText(choice, collector)) yield emitPart(choice, pendingPart);
        if (closed) units.delete(unit.path);
      }
      if (queue.head === undefined) queues.delete(choice);
    }
  };

  // The terminal candidate of a choice: finish reason, grounding built from its citations, and logprobs.
  const terminalCandidate = (record: Extract<IRRecord, { type: 'choice_end' }>, state: IR, collector: IRCollector): GeminiGenerateContentCandidate => {
    const choice = state.choices[record.choice];
    const partTexts = new Map<number, { text: string; coordinateIndex?: TextCoordinateIndex }>();
    for (const [partIndex, segments] of segmentsByChoice.get(record.choice) ?? []) {
      let text = '';
      for (const segment of segments) {
        if (text.length !== segment.targetStart) throw new TypeError('GenerateContent text segments must remain contiguous');
        const source = collector.value<string>(segment.source);
        if (source === undefined) throw new TypeError(`GenerateContent text segment source is missing: ${JSON.stringify(segment.source)}`);
        text += source.slice(segment.sourceStart, segment.sourceEnd);
      }
      partTexts.set(partIndex, { text });
    }
    const chunks: GeminiGenerateContentGroundingChunk[] = [];
    const supports: NonNullable<NonNullable<GeminiGenerateContentCandidate['groundingMetadata']>['groundingSupports']> = [];
    choice.items.forEach((item, itemIndex) => {
      if (item.type !== 'message') return;
      item.content.forEach((content, partIndex) => {
        if (content.type !== 'text') return;
        for (const annotation of content.annotations ?? []) {
          if (annotation.output_text_range === undefined) continue;
          const chunk = groundingChunk(annotation);
          const chunkIndex = chunks.length; chunks.push(chunk);
          const outputRange = annotation.output_text_range;
          for (const segment of mappings.get(irPathKey(['choices', record.choice, 'items', itemIndex, 'content', partIndex, 'text'])) ?? []) {
            const start = Math.max(segment.sourceStart, outputRange.start);
            const end = Math.min(segment.sourceEnd, outputRange.end_exclusive);
            if (end <= start) continue;
            const partText = partTexts.get(segment.partIndex);
            if (partText === undefined) throw new TypeError(`GenerateContent text part ${segment.partIndex} is missing`);
            const range = { start: segment.targetStart + start - segment.sourceStart, end_exclusive: segment.targetStart + end - segment.sourceStart };
            partText.coordinateIndex ??= TextCoordinateIndex.utf16ToUTF8(partText.text);
            partText.coordinateIndex.assertUTF16Length(partText.text.length);
            const bytes = partText.coordinateIndex.irRangeToUTF8(range);
            supports.push({
              groundingChunkIndices: [chunkIndex],
              segment: { partIndex: segment.partIndex, startIndex: bytes.start, endIndex: bytes.end, text: partText.text.slice(range.start, range.end_exclusive) },
            });
          }
        }
      });
    });
    const tokens = choice.logprobs?.flatMap(group => group.tokens);
    return {
      ...(choice.refusal?.explanation == null ? {} : { finishMessage: choice.refusal.explanation }),
      index: record.choice,
      finishReason: record.finish_reason === 'length' ? 'MAX_TOKENS' : record.finish_reason === 'content_filter' ? 'SAFETY' : 'STOP',
      ...(chunks.length === 0 ? {} : { groundingMetadata: { groundingChunks: chunks, groundingSupports: supports } }),
      ...(tokens === undefined ? {} : { logprobsResult: logprobsResult(tokens) }),
    };
  };

  for await (const { record, collector } of consumeIRRecords(records)) {
    const { state } = collector;
    if (record.type === 'error') { yield eventFrame({ error: irGenerateContentError(record.error) }); return; }
    if (record.type === 'write' && record.path[0] === 'model' && typeof record.value === 'string') metadata.model = record.value;
    if (record.type === 'start') {
      if (state.model === undefined) throw new TypeError('GenerateContent output requires an IR model before start');
      const id = options.id ?? record.id;
      metadata = { id: id === undefined || id === '' ? crypto.randomUUID() : id, model: state.model };
      started = true;
      continue;
    }
    if (!started) continue;
    registerUnits(record, state);
    const pendingUnit = units.forRecord(record, state);
    if (pendingUnit !== undefined && record.type === 'write' && record.kind === 'append') {
      const field = pendingUnit.kind === 'audio' && record.path.at(-1) === 'data' ? 'pendingData'
        : pendingUnit.kind === 'function_call' && record.path[4] === 'arguments' ? 'pendingArguments' : undefined;
      if (field !== undefined) {
        const text = collector.value<string>(record.path);
        if (text === undefined) throw new Error('Missing GenerateContent pending field');
        (pendingUnit[field] ??= []).push(provenanceSpanForAppend(text, record.value, record.referencePieceIds));
      }
    }
    yield* openPendingUnits(record, state, collector);

    const unit = units.forRecord(record, state);
    if (unit !== undefined
      && record.type === 'write'
      && record.kind === 'append'
      && (unit.kind === 'text' || unit.kind === 'refusal' || unit.kind === 'audio' || unit.kind === 'reasoning')) {
      const choice = record.path[1] as number;
      const kind = textAppendKind(unit, record.path);
      if (kind !== undefined) {
        const sourceKey = irPathKey(record.path);
        const sourceStart = sourceLengths.get(sourceKey) ?? 0;
        const sourceEnd = sourceStart + record.value.length;
        sourceLengths.set(sourceKey, sourceEnd);
        if (!unit.opened) {
          const source = collector.value<string>(record.path);
          if (source === undefined) throw new Error('Missing GenerateContent pending text');
          let queue = pendingText.get(choice);
          if (queue === undefined) { queue = { values: [], head: 0 }; pendingText.set(choice, queue); }
          queue.values.push({
            unit,
            source: record.path,
            span: provenanceSpanForAppend(source, record.value, record.referencePieceIds),
            thought: kind === 'thought',
          });
        } else {
          const part = appendText(choice, record.path, record.value, kind === 'thought', record.referencePieceIds);
          if (part !== undefined) yield emitPart(choice, part);
        }
      }
    }

    if (record.type === 'item_end') {
      units.delete(irItemPath(record.choice, record.item));
    } else if (record.type === 'part_end') {
      units.delete(irPartPath(record.choice, record.item, record.part));
    }

    if (record.type === 'choice_end') {
      const nativeCandidate = nativeAccumulator.candidate(record.choice);
      const targetTurn: GeminiGenerateContentInputAssistantTurn = [{ role: 'model', parts: nativeCandidate?.content?.parts ?? [] }];
      const stateParts = partsState(record.choice);
      stateParts.length = targetTurn[0].parts?.length ?? 0;
      const assistantState: GeminiGenerateContentAssistantState<ContentStates> = [{ parts: stateParts }];
      const sourceTurnDigest = await computeGeminiGenerateContentTurnDigest(targetTurn);
      const data = await options.roundTrip.prepareSidecar(record.choice, sourceTurnDigest, targetTurn, assistantState, collectGeminiGenerateContentTextViews(targetTurn));
      yield emitPart(record.choice, createGeminiGenerateContentSidecarCarrier(data));
      yield emit({ candidates: [terminalCandidate(record, state, collector)] });
    }

    if (record.type === 'finish' && state.usage !== undefined) {
      const serviceTier = state.service_tier === 'fast' ? FAST_SERVICE_TIER : state.service_tier === 'default' ? 'standard' : state.service_tier;
      yield emit({ usageMetadata: { ...usageFromIR(state.usage), ...(serviceTier === undefined ? {} : { serviceTier }) } });
    }
  }
};

const logprobsResult = (tokens: readonly IRTokenLogprob[]): NonNullable<GeminiGenerateContentCandidate['logprobsResult']> => ({
  chosenCandidates: tokens.map(token => ({ token: token.token, logProbability: token.logprob })),
  topCandidates: tokens.map(token => ({
    candidates: (token.top_logprobs ?? []).map(alternative => ({ token: alternative.token, logProbability: alternative.logprob })),
  })),
});

const groundingChunk = (citation: IRSourceCitation): GeminiGenerateContentGroundingChunk => {
  if (citation.source_kind === 'url') return { web: { uri: citation.source, title: citation.source_label ?? undefined } };
  return {
    retrievedContext: {
      ...(citation.source == null ? {} : { uri: citation.source }),
      ...(citation.source_label == null ? {} : { title: citation.source_label }),
      ...(citation.source_text === undefined ? {} : { text: citation.source_text }),
      ...(citation.source_page_range === undefined ? {} : { pageNumber: citation.source_page_range.start_one_based }),
    },
  };
};
