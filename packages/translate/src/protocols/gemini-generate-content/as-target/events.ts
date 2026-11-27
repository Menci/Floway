import { klona } from 'klona/json';

import type { GeminiGenerateContentInputAssistantTurnState } from './assistant-turn.ts';
import { geminiGenerateContentErrorPayloadFromWire } from './error.ts';
import { usageToIR } from './usage.ts';
import type { ToolNameContext } from '../../../composition/request/tool-names.ts';
import { IRAbsent } from '../../../ir/output/absent.ts';
import { createIRBuilder, type IRItemHandle, type IRPartHandle, type IRRelativePath, type IRWriteHandle } from '../../../ir/output/builder.ts';
import type { IRRecord } from '../../../ir/output/records.ts';
import type { IROutputSourceCitation } from '../../../ir/output/types.ts';
import type { RoundTripReader } from '../../../round-trip/reader.ts';
import { appendReadField, createReadFieldState, type ReadFieldState, type ReadFieldStates } from '../../../round-trip/reference/reference-builder.ts';
import { unwrapCustomToolInput } from '../../../shared/custom-tool.ts';
import { isPlainJSONObject, requireJSONObject } from '../../../shared/json/object.ts';
import { TextCoordinateIndex } from '../../../shared/text-coordinate-index.ts';
import { geminiServiceTierToOutputIR } from '../service-tier.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import {
  GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE,
  appendGeminiGenerateContentPart,
  createGeminiGenerateContentCandidateCompletion,
  isGeminiGenerateContentErrorEvent,
  isGeminiGenerateContentPromptBlockReason,
  isGeminiGenerateContentTerminalFinishReason,
  type GeminiGenerateContentCandidate,
  type GeminiGenerateContentFinishReason,
  type GeminiGenerateContentGroundingChunk,
  type GeminiGenerateContentGroundingMetadata,
  type GeminiGenerateContentPart,
  type GeminiGenerateContentResult,
  type GeminiGenerateContentStreamEvent,
  type GeminiGenerateContentUsageMetadata,
} from '@floway-dev/protocols/gemini-generate-content';

// Gemini finish reasons indicating safety or policy filtering.
// https://ai.google.dev/api/generate-content#FinishReason
const CONTENT_FILTER_FINISH_REASONS: ReadonlySet<string> = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'IMAGE_RECITATION',
]);

// Gemini finish reasons meaning the model's own output was unusable. They
// surface as a stream error instead of an empty completed turn, so an agent
// loop sees the failure rather than a silent stop.
// https://ai.google.dev/api/generate-content#FinishReason
const FAILED_OUTPUT_FINISH_REASONS: ReadonlySet<string> = new Set([
  'MALFORMED_FUNCTION_CALL',
  'UNEXPECTED_TOOL_CALL',
  'TOO_MANY_TOOL_CALLS',
  'MISSING_THOUGHT_SIGNATURE',
  'MALFORMED_RESPONSE',
]);

const USAGE_METADATA_KEYS: readonly (keyof GeminiGenerateContentUsageMetadata)[] = [
  'promptTokenCount',
  'candidatesTokenCount',
  'totalTokenCount',
  'cachedContentTokenCount',
  'thoughtsTokenCount',
  'toolUsePromptTokenCount',
  'promptTokensDetails',
  'cacheTokensDetails',
  'candidatesTokensDetails',
  'toolUsePromptTokensDetails',
  'serviceTier',
];

const mapFinishReason = (
  finishReason: GeminiGenerateContentFinishReason,
  hasToolCalls: boolean,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' => {
  if (finishReason === 'MAX_TOKENS') return 'length';
  if (CONTENT_FILTER_FINISH_REASONS.has(finishReason)) return 'content_filter';
  if (hasToolCalls && finishReason === 'STOP') return 'tool_calls';
  return 'stop';
};

const ensureSegmentIndex = (segment: TextSegment): TextCoordinateIndex => {
  segment.coordinateIndex ??= TextCoordinateIndex.utf8ToUTF16(segment.text);
  segment.coordinateIndex.assertUTF16Length(segment.text.length);
  return segment.coordinateIndex;
};

const matchesSegmentText = (
  segment: TextSegment,
  startByte: number,
  endByte: number | undefined,
  expectedText: string,
): boolean => {
  if (endByte === undefined || !Number.isInteger(startByte) || !Number.isInteger(endByte) || startByte < 0 || endByte <= startByte) {
    return false;
  }
  const index = ensureSegmentIndex(segment);
  if (endByte > index.utf8Length) return false;
  try {
    const range = index.utf8RangeToUTF16(startByte, endByte);
    return segment.text.slice(range.start, range.end_exclusive) === expectedText;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
};

// Proto3 JSON omits default zero values like `startIndex: 0` and `partIndex: 0`.
// https://protobuf.dev/programming-guides/json/#field-presence
const utf8ByteRangeToUTF16 = (
  choiceIndex: number,
  segment: TextSegment,
  startByte: number | undefined,
  endByte: number | undefined,
): { start: number; end_exclusive: number } | undefined => {
  if (endByte === undefined) return undefined;
  const rawStart = startByte ?? 0;
  if (!Number.isInteger(rawStart) || !Number.isInteger(endByte) || rawStart < 0 || endByte <= rawStart) {
    console.warn('Dropping Gemini GenerateContent grounding range with invalid byte bounds', { choice: choiceIndex, startByte: rawStart, endByte });
    return undefined;
  }
  const index = ensureSegmentIndex(segment);
  const availableBytes = index.utf8Length;
  const clampedStart = Math.min(rawStart, availableBytes);
  const clampedEnd = Math.min(endByte, availableBytes);
  if (endByte > availableBytes) {
    console.warn(
      clampedStart >= clampedEnd
        ? 'Dropping Gemini GenerateContent grounding range outside streamed text'
        : 'Clamping Gemini GenerateContent grounding range to streamed text',
      { choice: choiceIndex, startByte: rawStart, endByte, availableBytes },
    );
  }
  if (clampedStart >= clampedEnd) return undefined;
  try {
    const relative = index.utf8RangeToUTF16(clampedStart, clampedEnd);
    return {
      start: segment.utf16Base + relative.start,
      end_exclusive: segment.utf16Base + relative.end_exclusive,
    };
  } catch (error) {
    if (error instanceof RangeError) {
      console.warn('Dropping Gemini GenerateContent grounding range that splits a UTF-8 character', { choice: choiceIndex, startByte: clampedStart, endByte: clampedEnd });
      return undefined;
    }
    throw error;
  }
};

const groundingChunkToCitation = (
  chunk: GeminiGenerateContentGroundingChunk,
  range: { start: number; end_exclusive: number } | undefined,
): IROutputSourceCitation | undefined => {
  const rangeField = range === undefined ? {} : { output_text_range: range };
  if (typeof chunk.web?.uri === 'string' && chunk.web.uri !== '') {
    return {
      type: 'source_citation',
      source_kind: 'url',
      source: chunk.web.uri,
      ...(chunk.web.title === undefined ? {} : { source_label: chunk.web.title }),
      ...rangeField,
    };
  }
  const retrieved = chunk.retrievedContext;
  if (retrieved === undefined) return undefined;
  const source = typeof retrieved.uri === 'string' && retrieved.uri !== '' ? retrieved.uri : undefined;
  const sourceText = typeof retrieved.text === 'string' && retrieved.text !== '' ? retrieved.text : undefined;
  if (source === undefined && sourceText === undefined) return undefined;
  return {
    type: 'source_citation',
    source_kind: 'document',
    ...(source === undefined ? {} : { source }),
    ...(retrieved.title === undefined ? {} : { source_label: retrieved.title }),
    ...(sourceText === undefined ? {} : { source_text: sourceText }),
    ...(Number.isInteger(retrieved.pageNumber) && (retrieved.pageNumber as number) > 0
      ? { source_page_range: { start_one_based: retrieved.pageNumber as number, end_one_based_exclusive: (retrieved.pageNumber as number) + 1 } }
      : {}),
    ...rangeField,
  } as IROutputSourceCitation;
};

type PartsFieldState = NonNullable<NonNullable<GeminiGenerateContentInputAssistantTurnState<ReadFieldStates>[number]>['parts']>;

interface TextPartRecord {
  readonly part: IRPartHandle;
  readonly citations: IROutputSourceCitation[];
  readonly citationKeys: Set<string>;
}

interface TextSegment {
  readonly textPart: TextPartRecord;
  readonly utf16Base: number;
  text: string;
  coordinateIndex?: TextCoordinateIndex;
}

interface GeminiChoiceState {
  readonly irIndex: number;
  message?: IRItemHandle | undefined;
  activeTextSegment?: TextSegment | undefined;
  reasoning?: IRItemHandle | undefined;
  readonly nativeParts: GeminiGenerateContentPart[];
  readonly partsFieldState: PartsFieldState;
  readonly textSegmentsByNativeIndex: Map<number, TextSegment>;
  readonly textSegmentsByLogicalIndex: Map<number, TextSegment>;
  firstTextSegment?: TextSegment | undefined;
  logicalPartCount: number;
  lastLogicalKind: 'none' | 'thought' | 'text' | 'other';
  hasToolCalls: boolean;
  logprobTokenCount: number;
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  ended: boolean;
}

const mergeUsageMetadata = (
  target: GeminiGenerateContentUsageMetadata,
  incoming: GeminiGenerateContentUsageMetadata,
): void => {
  for (const key of USAGE_METADATA_KEYS) {
    const value = incoming[key];
    if (value == null || (Array.isArray(value) && value.length === 0)) continue;
    (target as Record<string, unknown>)[key] = value;
  }
};

// Reconcile native `Content.parts` indices with logical response part indices:
// streaming thought chunks and mid-text `thoughtSignature` chunks stay split in
// `nativeParts` for round-trip fidelity, while Gemini grounding may address the
// merged logical part or omit `partIndex` (proto3 default `0`).
// https://ai.google.dev/api/generate-content#Segment
const resolveGroundingSegment = (
  choice: GeminiChoiceState,
  segmentSpec: NonNullable<NonNullable<GeminiGenerateContentGroundingMetadata['groundingSupports']>[number]['segment']> | undefined,
): TextSegment | undefined => {
  const partIndex = segmentSpec?.partIndex ?? 0;
  const candidates: TextSegment[] = [];
  const addCandidate = (segment: TextSegment | undefined): void => {
    if (segment !== undefined && !candidates.includes(segment)) candidates.push(segment);
  };
  addCandidate(choice.textSegmentsByNativeIndex.get(partIndex));
  addCandidate(choice.textSegmentsByLogicalIndex.get(partIndex));
  if (partIndex === 0) addCandidate(choice.firstTextSegment);
  if (candidates.length <= 1) return candidates[0];

  const startByte = segmentSpec?.startIndex ?? 0;
  const endByte = segmentSpec?.endIndex;
  if (typeof segmentSpec?.text === 'string' && segmentSpec.text !== '') {
    const byText = candidates.find(candidate => matchesSegmentText(candidate, startByte, endByte, segmentSpec.text!));
    if (byText !== undefined) return byText;
  }
  if (typeof endByte === 'number' && Number.isInteger(endByte) && endByte > 0) {
    const byBounds = candidates.find(candidate => endByte <= ensureSegmentIndex(candidate).utf8Length);
    if (byBounds !== undefined) return byBounds;
  }
  return candidates[0];
};

export const readGeminiGenerateContentEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>,
  options: Partial<ToolNameContext> & {
    readonly fallbackModel?: string;
    readonly roundTrip: RoundTripReader<'geminiGenerateContent'>;
  },
): AsyncGenerator<IRRecord> {
  const ir = createIRBuilder();
  const namingOf = (wireName: string) => options.originalToolNames?.get(wireName) ?? { name: wireName };
  const completion = createGeminiGenerateContentCandidateCompletion();
  const choices = new Map<number, GeminiChoiceState>();
  const accumulatedUsage: GeminiGenerateContentUsageMetadata = {};
  let nextIRChoiceIndex = 0;
  let started = false;
  let hasModel = false;

  const choiceState = (wireIndex: number): GeminiChoiceState => {
    let state = choices.get(wireIndex);
    if (state === undefined) {
      state = {
        irIndex: nextIRChoiceIndex++,
        nativeParts: [],
        partsFieldState: [],
        textSegmentsByNativeIndex: new Map(),
        textSegmentsByLogicalIndex: new Map(),
        logicalPartCount: 0,
        lastLogicalKind: 'none',
        hasToolCalls: false,
        logprobTokenCount: 0,
        ended: false,
      };
      choices.set(wireIndex, state);
    }
    return state;
  };

  const appendTextField = (
    handle: IRWriteHandle,
    field: IRRelativePath,
    text: string,
    state: ReadFieldState<'text'>,
  ): void => {
    const pieceId = appendReadField(options.roundTrip.builder, state, text);
    handle.append(field, text, [pieceId]);
  };

  const closeMessage = (choice: GeminiChoiceState, status: 'completed' | 'incomplete' = 'completed'): void => {
    choice.activeTextSegment = undefined;
    if (choice.message === undefined) return;
    choice.message.end(status);
    choice.message = undefined;
  };

  const closeReasoning = (choice: GeminiChoiceState, status: 'completed' | 'incomplete' = 'completed'): void => {
    if (choice.reasoning === undefined) return;
    choice.reasoning.end(status);
    choice.reasoning = undefined;
  };

  const assignUsage = (usage: GeminiGenerateContentUsageMetadata): void => {
    mergeUsageMetadata(accumulatedUsage, usage);
    ir.usage(usageToIR(accumulatedUsage));
    const tier = geminiServiceTierToOutputIR(typeof usage.serviceTier === 'string' ? usage.serviceTier : undefined);
    if (tier !== undefined) ir.assign(['service_tier'], tier);
  };

  const ensureStarted = (event: GeminiGenerateContentResult): void => {
    const incomingModel = typeof event.modelVersion === 'string' && event.modelVersion !== '' ? event.modelVersion : undefined;
    const model = incomingModel ?? (!hasModel && typeof options.fallbackModel === 'string' && options.fallbackModel !== '' ? options.fallbackModel : undefined);
    if (model !== undefined) {
      hasModel = true;
      ir.assign(['model'], model);
    }
    if (!started && !hasModel) throw new TypeError('Gemini GenerateContent stream arrived before a non-empty model');
    if (event.usageMetadata != null) assignUsage(event.usageMetadata);
    if (started) return;
    ir.event({
      type: 'start',
      ...(typeof event.responseId === 'string' && event.responseId !== '' ? { id: event.responseId } : {}),
    });
    started = true;
  };

  const applyGroundingMetadata = (choiceIndex: number, choice: GeminiChoiceState, metadata: GeminiGenerateContentGroundingMetadata): void => {
    const chunks = metadata.groundingChunks ?? [];
    if (chunks.length === 0) return;
    const touched = new Set<TextPartRecord>();
    for (const support of metadata.groundingSupports ?? []) {
      const segment = resolveGroundingSegment(choice, support.segment);
      if (segment === undefined) continue;
      if (!segment.textPart.part.isOpen) {
        console.warn('Dropping Gemini GenerateContent grounding citation for closed text part', {
          choice: choiceIndex,
          partIndex: support.segment?.partIndex ?? 0,
        });
        continue;
      }
      const range = utf8ByteRangeToUTF16(choiceIndex, segment, support.segment?.startIndex, support.segment?.endIndex);
      for (const chunkIndex of support.groundingChunkIndices ?? []) {
        const chunk = chunks[chunkIndex];
        if (chunk === undefined) continue;
        const citation = groundingChunkToCitation(chunk, range);
        if (citation === undefined) continue;
        // Keep `annotations` append-only across cumulative snapshots so streaming
        // consumers (such as Responses) never skip or duplicate earlier entries.
        const key = JSON.stringify(citation);
        if (segment.textPart.citationKeys.has(key)) continue;
        segment.textPart.citationKeys.add(key);
        segment.textPart.citations.push(citation);
        touched.add(segment.textPart);
      }
    }
    for (const textPart of touched) {
      textPart.part.assign('annotations', [...textPart.citations]);
    }
  };

  const applyLogprobs = (choiceIndex: number, choice: GeminiChoiceState, candidate: GeminiGenerateContentCandidate): void => {
    const chosen = candidate.logprobsResult?.chosenCandidates;
    if (chosen === undefined || chosen.length === 0) return;
    const top = candidate.logprobsResult?.topCandidates ?? [];
    const handle = ir.choice(choiceIndex);
    for (let i = 0; i < chosen.length; i++) {
      const entry = chosen[i];
      if (typeof entry.token !== 'string' || typeof entry.logProbability !== 'number') continue;
      const alternatives = top[i]?.candidates?.flatMap(alt =>
        typeof alt.token === 'string' && typeof alt.logProbability === 'number'
          ? [{ token: alt.token, logprob: alt.logProbability }]
          : []);
      if (choice.logprobTokenCount === 0) {
        handle.initialize('logprobs', []);
        handle.initialize(['logprobs', 0], { scope: 'choice', tokens: [] });
      }
      handle.assign(['logprobs', 0, 'tokens', choice.logprobTokenCount++], {
        token: entry.token,
        logprob: entry.logProbability,
        ...(alternatives === undefined || alternatives.length === 0 ? {} : { top_logprobs: alternatives }),
      });
    }
  };

  const readPart = (choiceIndex: number, choice: GeminiChoiceState, part: GeminiGenerateContentPart): void => {
    const partIndex = appendGeminiGenerateContentPart(choice.nativeParts, part);
    const isThought = part.thought === true;

    if (isThought) {
      if (choice.lastLogicalKind !== 'thought') {
        choice.logicalPartCount++;
        choice.lastLogicalKind = 'thought';
      }
      if (typeof part.text === 'string' && part.text !== '') {
        closeMessage(choice);
        choice.reasoning ??= ir.item(choiceIndex, { type: 'reasoning', summary: [''] });
        const textField = createReadFieldState('text');
        choice.partsFieldState[partIndex] = { text: textField };
        appendTextField(choice.reasoning, ['summary', 0], part.text, textField);
      }
      return;
    }

    if (typeof part.text === 'string') {
      if (part.text === '') return;
      closeReasoning(choice);
      choice.message ??= ir.item(choiceIndex, { type: 'message', content: [] });
      if (choice.activeTextSegment === undefined) {
        const textPart: TextPartRecord = {
          part: choice.message.part({ type: 'text', text: '' }),
          citations: [],
          citationKeys: new Set(),
        };
        const logicalSegment: TextSegment = { textPart, utf16Base: 0, text: '' };
        choice.activeTextSegment = logicalSegment;
        const logicalIndex = choice.logicalPartCount++;
        choice.lastLogicalKind = 'text';
        choice.textSegmentsByLogicalIndex.set(logicalIndex, logicalSegment);
        choice.firstTextSegment ??= logicalSegment;
      }
      const { textPart } = choice.activeTextSegment;
      let nativeSegment = choice.textSegmentsByNativeIndex.get(partIndex);
      if (nativeSegment === undefined) {
        nativeSegment = {
          textPart,
          utf16Base: choice.activeTextSegment.text.length,
          text: '',
        };
        choice.textSegmentsByNativeIndex.set(partIndex, nativeSegment);
      }
      const existingState = choice.partsFieldState[partIndex];
      const existingTextField = existingState !== undefined && 'text' in existingState ? existingState.text : undefined;
      const textField = existingTextField ?? createReadFieldState('text');
      if (existingTextField === undefined) choice.partsFieldState[partIndex] = { text: textField };
      appendTextField(textPart.part, 'text', part.text, textField);
      nativeSegment.text += part.text;
      nativeSegment.coordinateIndex?.append(part.text);
      choice.activeTextSegment.text += part.text;
      choice.activeTextSegment.coordinateIndex?.append(part.text);
      return;
    }

    if (part.functionCall !== undefined) {
      choice.logicalPartCount++;
      choice.lastLogicalKind = 'other';
      closeReasoning(choice);
      closeMessage(choice);
      choice.hasToolCalls = true;
      const call = part.functionCall;
      if (typeof call.name !== 'string' || call.name === '') {
        throw new TypeError('Gemini GenerateContent functionCall requires a non-empty name');
      }
      const callId = typeof call.id === 'string' && call.id !== '' ? call.id : IRAbsent;
      const argsJson = JSON.stringify(requireJSONObject(call.args ?? {}));
      const naming = namingOf(call.name);
      if (options.customToolNames?.has(call.name) === true) {
        const item = ir.item(choiceIndex, { type: 'custom_tool_call', call_id: callId, ...naming, input: '' });
        const unwrapped = unwrapCustomToolInput(argsJson);
        if (unwrapped !== '') item.append('input', unwrapped);
        item.end('completed');
      } else {
        const item = ir.item(choiceIndex, { type: 'function_call', call_id: callId, ...naming, arguments: '' });
        if (isPlainJSONObject(call.args)) {
          const jsonField = createReadFieldState('json');
          const pieceId = appendReadField(options.roundTrip.builder, jsonField, argsJson);
          choice.partsFieldState[partIndex] = { functionCall: { args: jsonField } };
          item.append('arguments', argsJson, [pieceId]);
        } else {
          item.append('arguments', argsJson);
        }
        item.end('completed');
      }
      return;
    }

    if (part.inlineData !== undefined) {
      choice.logicalPartCount++;
      choice.lastLogicalKind = 'other';
      const mimeType = part.inlineData.mimeType.toLowerCase();
      const isAudio = mimeType.startsWith('audio/') || part.audioTranscription !== undefined;
      const isImage = !isAudio && mimeType.startsWith('image/');
      if (!isAudio && !isImage) return;
      closeReasoning(choice);
      if (choice.activeTextSegment !== undefined) {
        choice.activeTextSegment.textPart.part.end();
        choice.activeTextSegment = undefined;
      }
      choice.message ??= ir.item(choiceIndex, { type: 'message', content: [] });

      if (isAudio) {
        const transcript = typeof part.audioTranscription?.text === 'string' ? part.audioTranscription.text : undefined;
        const audioPart = choice.message.part({
          type: 'audio',
          audio: {
            media_type: part.inlineData.mimeType,
            data: '',
            ...(transcript === undefined ? {} : { transcript: '' }),
          },
        });
        const dataField = part.inlineData.data === '' ? undefined : createReadFieldState('text');
        if (dataField !== undefined) appendTextField(audioPart, ['audio', 'data'], part.inlineData.data, dataField);
        let transcriptField: ReadFieldState<'text'> | undefined;
        if (transcript !== undefined && transcript !== '') {
          transcriptField = createReadFieldState('text');
          appendTextField(audioPart, ['audio', 'transcript'], transcript, transcriptField);
        }
        if (dataField !== undefined || transcriptField !== undefined) {
          choice.partsFieldState[partIndex] = {
            ...(dataField === undefined ? {} : { inlineData: { data: dataField } }),
            ...(transcriptField === undefined ? {} : { audioTranscription: { text: transcriptField } }),
          };
        }
        audioPart.end();
      } else {
        choice.message.part({
          type: 'image',
          image: { data: part.inlineData.data, media_type: part.inlineData.mimeType },
        }).end();
      }
      return;
    }

    if (part.executableCode !== undefined || part.codeExecutionResult !== undefined || part.toolCall !== undefined || part.toolResponse !== undefined || part.fileData !== undefined) {
      choice.logicalPartCount++;
      choice.lastLogicalKind = 'other';
    }
  };

  const endChoice = (
    choice: GeminiChoiceState,
    finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter',
  ): void => {
    if (choice.ended) return;
    const status = finishReason === 'length' ? 'incomplete' : 'completed';
    closeReasoning(choice, status);
    closeMessage(choice, status);
    const nativeParts = klona(choice.nativeParts);
    choice.partsFieldState.length = nativeParts.length;
    options.roundTrip.onAssistantTurn(
      choice.irIndex,
      [{ role: 'model', parts: nativeParts }],
      [{ parts: choice.partsFieldState }],
    );
    ir.choice(choice.irIndex).end(finishReason);
    choice.finishReason = finishReason;
    choice.ended = true;
  };

  const finishStatus = (): 'completed' | 'incomplete' =>
    [...choices.values()].some(choice => choice.finishReason === 'length') ? 'incomplete' : 'completed';

  const finishStream = function* (): Generator<IRRecord> {
    if (!started || !completion.isComplete()) {
      throw new Error(GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE);
    }
    ir.event({ type: 'finish', status: finishStatus() });
    yield* ir.drain();
  };

  const emitFailedFinishError = (finishReason: GeminiGenerateContentFinishReason, finishMessage: string | undefined): void => {
    const suffix = finishMessage !== undefined && finishMessage !== '' ? `: ${finishMessage}` : '';
    ir.event({
      type: 'error',
      error: {
        message: `Gemini ended the response with ${finishReason}${suffix}`,
        type: 'api_error',
        code: finishReason,
      },
    });
  };

  for await (const frame of frames) {
    if (frame.type === 'done') {
      yield* finishStream();
      return;
    }
    const event = frame.event;
    if (isGeminiGenerateContentErrorEvent(event)) {
      ir.event({ type: 'error', error: geminiGenerateContentErrorPayloadFromWire(event) });
      yield* ir.drain();
      return;
    }

    ensureStarted(event);

    const blockReason = event.promptFeedback?.blockReason;
    if (isGeminiGenerateContentPromptBlockReason(blockReason)) {
      const targetChoices = choices.size === 0 ? [choiceState(0)] : [...choices.values()].filter(choice => !choice.ended);
      for (const choice of targetChoices) {
        ir.choice(choice.irIndex).assign('refusal_details', {
          category: blockReason,
          explanation: event.promptFeedback?.blockReasonMessage ?? null,
        });
        endChoice(choice, 'content_filter');
      }
      ir.event({ type: 'finish', status: finishStatus() });
      yield* ir.drain();
      return;
    }

    completion.observe(event);

    for (const candidate of event.candidates ?? []) {
      const wireIndex = candidate.index ?? 0;
      const existing = choices.get(wireIndex);
      if (existing?.ended) continue;

      const finishReason = candidate.finishReason;
      const isTerminal = isGeminiGenerateContentTerminalFinishReason(finishReason);
      const isFailed = isTerminal && FAILED_OUTPUT_FINISH_REASONS.has(finishReason);
      const hasParts = (candidate.content?.parts?.length ?? 0) > 0;
      if (isFailed && !hasParts && existing === undefined) {
        emitFailedFinishError(finishReason, candidate.finishMessage);
        yield* ir.drain();
        return;
      }

      const choice = choiceState(wireIndex);
      ir.choice(choice.irIndex);

      for (const part of candidate.content?.parts ?? []) {
        readPart(choice.irIndex, choice, part);
      }
      if (candidate.groundingMetadata !== undefined) {
        applyGroundingMetadata(choice.irIndex, choice, candidate.groundingMetadata);
      }
      if (candidate.logprobsResult !== undefined) {
        applyLogprobs(choice.irIndex, choice, candidate);
      }
      if (isFailed) {
        emitFailedFinishError(finishReason, candidate.finishMessage);
        yield* ir.drain();
        return;
      }
      if (isTerminal) {
        const mapped = mapFinishReason(finishReason, choice.hasToolCalls);
        if (mapped === 'content_filter') {
          ir.choice(choice.irIndex).assign('refusal_details', {
            category: finishReason,
            explanation: candidate.finishMessage ?? null,
          });
        }
        endChoice(choice, mapped);
      }
    }

    yield* ir.drain();
  }

  yield* finishStream();
};
