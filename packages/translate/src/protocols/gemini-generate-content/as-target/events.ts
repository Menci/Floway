import { klona } from 'klona/json';

import type { GeminiGenerateContentInputAssistantTurnState } from './assistant-turn.ts';
import { geminiGenerateContentErrorPayloadFromWire } from './error.ts';
import { usageToIR } from './usage.ts';
import type { ToolNameContext } from '../../../composition/request/tool-names.ts';
import { IRAbsent } from '../../../ir/output/absent.ts';
import { createIRBuilder, type IRItemHandle, type IRPartHandle } from '../../../ir/output/builder.ts';
import type { IRRecord } from '../../../ir/output/records.ts';
import type { IROutputSourceCitation, IROutputTokenLogprob } from '../../../ir/output/types.ts';
import type { RoundTripReader } from '../../../round-trip/reader.ts';
import { appendReadField, createReadFieldState, type ReadFieldState, type ReadFieldStates } from '../../../round-trip/reference/reference-builder.ts';
import { unwrapCustomToolInput } from '../../../shared/custom-tool.ts';
import { isPlainJSONObject, requireJSONObject } from '../../../shared/json/object.ts';
import { TextCoordinateIndex } from '../../../shared/text-coordinate-index.ts';
import { FAST_SERVICE_TIER, type ProtocolFrame } from '@floway-dev/protocols/common';
import {
  GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE,
  createGeminiGenerateContentCandidateCompletion,
  isGeminiGenerateContentTerminalFinishReason,
  createGeminiGenerateContentEventAccumulator,
  isMergeableGeminiGenerateContentTextPart,
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
const CONTENT_FILTER_FINISH_REASONS: Readonly<Record<string, true>> = {
  SAFETY: true,
  RECITATION: true,
  BLOCKLIST: true,
  PROHIBITED_CONTENT: true,
  SPII: true,
  IMAGE_SAFETY: true,
  IMAGE_PROHIBITED_CONTENT: true,
  IMAGE_RECITATION: true,
};

// Gemini finish reasons meaning the model's own output was unusable. They
// surface as a stream error instead of an empty completed turn, so an agent
// loop sees the failure rather than a silent stop.
// https://ai.google.dev/api/generate-content#FinishReason
const FAILED_OUTPUT_FINISH_REASONS: Readonly<Record<string, true>> = {
  MALFORMED_FUNCTION_CALL: true,
  UNEXPECTED_TOOL_CALL: true,
  TOO_MANY_TOOL_CALLS: true,
  MISSING_THOUGHT_SIGNATURE: true,
  MALFORMED_RESPONSE: true,
};

const mapFinishReason = (
  finishReason: GeminiGenerateContentFinishReason,
  hasToolCalls: boolean,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' => {
  if (finishReason === 'MAX_TOKENS') return 'length';
  if (CONTENT_FILTER_FINISH_REASONS[finishReason]) return 'content_filter';
  if (hasToolCalls && finishReason === 'STOP') return 'tool_calls';
  return 'stop';
};

const utf8ByteRangeToUTF16 = (
  segment: NativeTextSegment,
  startByte: number | undefined,
  endByte: number | undefined,
): { start: number; end_exclusive: number } | undefined => {
  // Proto3 JSON omits default zero values like `startIndex: 0`.
  if (endByte === undefined) return undefined;
  segment.coordinateIndex ??= TextCoordinateIndex.utf8ToUTF16(segment.text);
  segment.coordinateIndex.assertUTF16Length(segment.text.length);
  try {
    const relative = segment.coordinateIndex.utf8RangeToUTF16(startByte ?? 0, endByte);
    return {
      start: segment.utf16Base + relative.start,
      end_exclusive: segment.utf16Base + relative.end_exclusive,
    };
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) return undefined;
    throw error;
  }
};

const groundingChunkToCitation = (
  chunk: GeminiGenerateContentGroundingChunk,
  range: { start: number; end_exclusive: number } | undefined,
): IROutputSourceCitation | undefined => {
  const rangeField = range === undefined ? {} : { output_text_range: range };
  if (chunk.web?.uri !== undefined) {
    return {
      type: 'source_citation',
      source_kind: 'url',
      source: chunk.web.uri,
      ...(chunk.web.title === undefined ? {} : { source_label: chunk.web.title }),
      ...rangeField,
    };
  }
  const retrieved = chunk.retrievedContext;
  if (retrieved !== undefined) {
    const pageField = retrieved.pageNumber === undefined
      ? {}
      : { source_page_range: { start_one_based: retrieved.pageNumber, end_one_based_exclusive: retrieved.pageNumber + 1 } };
    const labelField = retrieved.title === undefined ? {} : { source_label: retrieved.title };
    const textField = retrieved.text === undefined ? {} : { source_text: retrieved.text };
    if (retrieved.uri !== undefined) {
      return {
        type: 'source_citation',
        source_kind: 'document',
        source: retrieved.uri,
        ...labelField,
        ...textField,
        ...pageField,
        ...rangeField,
      };
    }
    if (retrieved.text !== undefined) {
      return {
        type: 'source_citation',
        source_kind: 'document',
        source_text: retrieved.text,
        ...labelField,
        ...pageField,
        ...rangeField,
      };
    }
  }
  return undefined;
};

type PartsFieldState = NonNullable<NonNullable<GeminiGenerateContentInputAssistantTurnState<ReadFieldStates>[number]>['parts']>;

interface TextPartRecord {
  readonly part: IRPartHandle;
  readonly citationsByNativeIndex: Map<number, readonly IROutputSourceCitation[]>;
  utf16Length: number;
}

interface NativeTextSegment {
  readonly textPart: TextPartRecord;
  readonly utf16Base: number;
  text: string;
  coordinateIndex?: TextCoordinateIndex;
}

interface GeminiChoiceState {
  readonly irIndex: number;
  message?: IRItemHandle | undefined;
  activeTextPart?: TextPartRecord | undefined;
  reasoning?: IRItemHandle | undefined;
  readonly partsFieldState: PartsFieldState;
  readonly idlessCallItemIndices: number[];
  readonly textSegmentsByNativeIndex: Map<number, NativeTextSegment>;
  nativePartCount: number;
  lastPartMergeableText: boolean;
  hasToolCalls: boolean;
  logprobTokenCount: number;
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  ended: boolean;
}

export const readGeminiGenerateContentEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>,
  options: Partial<ToolNameContext> & {
    readonly fallbackModel?: string;
    readonly roundTrip: RoundTripReader<'geminiGenerateContent'>;
  },
): AsyncGenerator<IRRecord> {
  const ir = createIRBuilder();
  const namingOf = (wireName: string) => options.originalToolNames?.get(wireName) ?? { name: wireName };
  const nativeAccumulator = createGeminiGenerateContentEventAccumulator();
  const completion = createGeminiGenerateContentCandidateCompletion();
  const choices = new Map<number, GeminiChoiceState>();
  let nextIRChoiceIndex = 0;
  let started = false;
  let currentModel: string | undefined;

  const choiceState = (wireIndex: number): GeminiChoiceState => {
    let state = choices.get(wireIndex);
    if (state === undefined) {
      state = {
        irIndex: nextIRChoiceIndex++,
        partsFieldState: [],
        idlessCallItemIndices: [],
        textSegmentsByNativeIndex: new Map(),
        nativePartCount: 0,
        lastPartMergeableText: false,
        hasToolCalls: false,
        logprobTokenCount: 0,
        ended: false,
      };
      choices.set(wireIndex, state);
    }
    return state;
  };

  const closeTextPart = (choice: GeminiChoiceState): void => {
    if (choice.activeTextPart === undefined) return;
    choice.activeTextPart.part.end();
    choice.activeTextPart = undefined;
  };

  const closeMessage = (choice: GeminiChoiceState, status: 'completed' | 'incomplete' = 'completed'): void => {
    closeTextPart(choice);
    if (choice.message === undefined) return;
    choice.message.end(status);
    choice.message = undefined;
  };

  const closeReasoning = (choice: GeminiChoiceState, status: 'completed' | 'incomplete' = 'completed'): void => {
    if (choice.reasoning === undefined) return;
    choice.reasoning.end(status);
    choice.reasoning = undefined;
  };

  const ensureStarted = (event: GeminiGenerateContentResult): void => {
    const model = typeof event.modelVersion === 'string' && event.modelVersion !== ''
      ? event.modelVersion
      : currentModel ?? options.fallbackModel ?? '';
    if (model !== currentModel) {
      currentModel = model;
      ir.assign(['model'], model);
    }
    if (started) return;
    ir.event({
      type: 'start',
      ...(typeof event.responseId === 'string' && event.responseId !== '' ? { id: event.responseId } : {}),
    });
    started = true;
  };

  const assignUsage = (usage: GeminiGenerateContentUsageMetadata): void => {
    ir.usage(usageToIR(usage));
    if (typeof usage.serviceTier === 'string' && usage.serviceTier !== '') {
      const tier = usage.serviceTier === FAST_SERVICE_TIER
        ? 'fast'
        : usage.serviceTier === 'standard'
          ? 'default'
          : usage.serviceTier;
      ir.assign(['service_tier'], tier);
    }
  };

  const applyGroundingMetadata = (choiceIndex: number, choice: GeminiChoiceState, metadata: GeminiGenerateContentGroundingMetadata): void => {
    const chunks = metadata.groundingChunks ?? [];
    if (chunks.length === 0) return;
    // Gemini may send cumulative groundingMetadata snapshots across frames; replace per touched native partIndex.
    const nextByNativePart = new Map<number, IROutputSourceCitation[]>();
    for (const support of metadata.groundingSupports ?? []) {
      const partIndex = support.segment?.partIndex ?? 0;
      const segment = choice.textSegmentsByNativeIndex.get(partIndex);
      if (segment === undefined) continue;
      if (!segment.textPart.part.isOpen) {
        console.warn('Dropping Gemini GenerateContent grounding citation for closed text part', { choice: choiceIndex, partIndex });
        continue;
      }
      const range = utf8ByteRangeToUTF16(segment, support.segment?.startIndex, support.segment?.endIndex);
      for (const chunkIndex of support.groundingChunkIndices ?? []) {
        const chunk = chunks[chunkIndex];
        if (chunk === undefined) continue;
        const citation = groundingChunkToCitation(chunk, range);
        if (citation === undefined) continue;
        let list = nextByNativePart.get(partIndex);
        if (list === undefined) {
          list = [];
          nextByNativePart.set(partIndex, list);
        }
        list.push(citation);
      }
    }
    const touchedTextParts = new Set<TextPartRecord>();
    for (const [partIndex, citations] of nextByNativePart) {
      const segment = choice.textSegmentsByNativeIndex.get(partIndex);
      if (segment === undefined || citations.length === 0) continue;
      segment.textPart.citationsByNativeIndex.set(partIndex, citations);
      touchedTextParts.add(segment.textPart);
    }
    for (const textPart of touchedTextParts) {
      if (!textPart.part.isOpen) continue;
      const merged = [...textPart.citationsByNativeIndex.entries()]
        .sort(([a], [b]) => a - b)
        .flatMap(([, citations]) => citations);
      textPart.part.assign('annotations', merged);
    }
  };

  const applyLogprobs = (choiceIndex: number, choice: GeminiChoiceState, candidate: GeminiGenerateContentCandidate): void => {
    const chosen = candidate.logprobsResult?.chosenCandidates;
    if (chosen === undefined || chosen.length === 0) return;
    const top = candidate.logprobsResult?.topCandidates ?? [];
    const tokens: IROutputTokenLogprob[] = [];
    for (let i = 0; i < chosen.length; i++) {
      const entry = chosen[i];
      if (typeof entry.token !== 'string' || typeof entry.logProbability !== 'number') continue;
      const alternatives = top[i]?.candidates?.flatMap(alt =>
        typeof alt.token === 'string' && typeof alt.logProbability === 'number'
          ? [{ token: alt.token, logprob: alt.logProbability }]
          : []);
      tokens.push({
        token: entry.token,
        logprob: entry.logProbability,
        ...(alternatives === undefined || alternatives.length === 0 ? {} : { top_logprobs: alternatives }),
      });
    }
    if (tokens.length === 0) return;
    const handle = ir.choice(choiceIndex);
    if (choice.logprobTokenCount === 0) {
      handle.initialize('logprobs', []);
      handle.initialize(['logprobs', 0], { scope: 'choice', tokens: [] });
    }
    for (const token of tokens) {
      handle.assign(['logprobs', 0, 'tokens', choice.logprobTokenCount++], token);
    }
  };

  const readPart = (choiceIndex: number, choice: GeminiChoiceState, part: GeminiGenerateContentPart): void => {
    const mergeable = isMergeableGeminiGenerateContentTextPart(part);
    const mergedIntoPrevious = choice.lastPartMergeableText && mergeable;
    const partIndex = mergedIntoPrevious ? choice.nativePartCount - 1 : choice.nativePartCount++;
    choice.lastPartMergeableText = mergeable;

    if (part.thought === true) {
      if (typeof part.text === 'string' && part.text !== '') {
        closeMessage(choice);
        choice.reasoning ??= ir.item(choiceIndex, { type: 'reasoning', summary: [''] });
        const textField = createReadFieldState('text');
        choice.partsFieldState[partIndex] = { text: textField };
        const pieceId = appendReadField(options.roundTrip.builder, textField, part.text);
        choice.reasoning.append(['summary', 0], part.text, [pieceId]);
      }
      return;
    }

    if (part.text !== undefined) {
      closeReasoning(choice);
      if (part.text !== '') {
        choice.message ??= ir.item(choiceIndex, { type: 'message', content: [] });
        choice.activeTextPart ??= {
          part: choice.message.part({ type: 'text', text: '' }),
          citationsByNativeIndex: new Map(),
          utf16Length: 0,
        };
        let segment = choice.textSegmentsByNativeIndex.get(partIndex);
        if (segment === undefined) {
          segment = {
            textPart: choice.activeTextPart,
            utf16Base: choice.activeTextPart.utf16Length,
            text: '',
          };
          choice.textSegmentsByNativeIndex.set(partIndex, segment);
        }
        const existingState = choice.partsFieldState[partIndex];
        const existingTextField = existingState !== undefined && 'text' in existingState ? existingState.text : undefined;
        const textField = existingTextField ?? createReadFieldState('text');
        if (existingTextField === undefined) choice.partsFieldState[partIndex] = { text: textField };
        const pieceId = appendReadField(options.roundTrip.builder, textField, part.text);
        choice.activeTextPart.part.append('text', part.text, [pieceId]);
        segment.text += part.text;
        segment.coordinateIndex?.append(part.text);
        choice.activeTextPart.utf16Length += part.text.length;
      }
      return;
    }

    if (part.functionCall !== undefined) {
      closeReasoning(choice);
      closeMessage(choice);
      choice.hasToolCalls = true;
      const call = part.functionCall;
      if (typeof call.name !== 'string' || call.name === '') {
        throw new TypeError('Gemini GenerateContent functionCall requires a non-empty name');
      }
      const hasWireId = typeof call.id === 'string' && call.id !== '';
      const callId = hasWireId ? call.id : IRAbsent;
      const argsObject = requireJSONObject(call.args ?? {});
      // TODO: preserve raw argument JSON via SSE frame slicing if upstream key/number formatting must survive untouched.
      const argsJson = JSON.stringify(argsObject);
      const naming = namingOf(call.name);
      const isCustom = options.customToolNames?.has(call.name) === true;

      if (isCustom) {
        const item = ir.item(choiceIndex, { type: 'custom_tool_call', call_id: callId, ...naming, input: '' });
        if (!hasWireId) choice.idlessCallItemIndices.push(item.index);
        const unwrapped = unwrapCustomToolInput(argsJson);
        if (unwrapped !== '') item.append('input', unwrapped);
        item.end('completed');
      } else {
        const item = ir.item(choiceIndex, { type: 'function_call', call_id: callId, ...naming, arguments: '' });
        if (!hasWireId) choice.idlessCallItemIndices.push(item.index);
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
      const isAudio = part.inlineData.mimeType.startsWith('audio/') || part.audioTranscription !== undefined;
      const isImage = !isAudio && part.inlineData.mimeType.startsWith('image/');
      if (!isAudio && !isImage) {
        // Output IR has no part for other inlineData MIME types (e.g. application/pdf, video/*);
        // the native part remains preserved in `targetTurn` via `nativeAccumulator`.
        return;
      }
      closeReasoning(choice);
      closeTextPart(choice);
      choice.message ??= ir.item(choiceIndex, { type: 'message', content: [] });

      if (isAudio) {
        const audioPart = choice.message.part({
          type: 'audio',
          audio: {
            media_type: part.inlineData.mimeType,
            data: '',
            ...(part.audioTranscription === undefined ? {} : { transcript: '' }),
          },
        });
        let dataField: ReadFieldState<'text'> | undefined;
        if (part.inlineData.data !== '') {
          dataField = createReadFieldState('text');
          const dataPieceId = appendReadField(options.roundTrip.builder, dataField, part.inlineData.data);
          audioPart.append(['audio', 'data'], part.inlineData.data, [dataPieceId]);
        }
        let transcriptField: ReadFieldState<'text'> | undefined;
        if (part.audioTranscription !== undefined && part.audioTranscription.text !== '') {
          transcriptField = createReadFieldState('text');
          const transcriptPieceId = appendReadField(options.roundTrip.builder, transcriptField, part.audioTranscription.text);
          audioPart.append(['audio', 'transcript'], part.audioTranscription.text, [transcriptPieceId]);
        }
        if (dataField !== undefined || transcriptField !== undefined) {
          choice.partsFieldState[partIndex] = {
            ...(dataField === undefined ? {} : { inlineData: { data: dataField } }),
            ...(transcriptField === undefined ? {} : { audioTranscription: { text: transcriptField } }),
          };
        }
        audioPart.end();
      } else {
        const imagePart = choice.message.part({
          type: 'image',
          image: {
            data: part.inlineData.data,
            media_type: part.inlineData.mimeType,
          },
        });
        imagePart.end();
      }
    }
  };

  const endChoice = (
    wireIndex: number,
    choice: GeminiChoiceState,
    finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter',
  ): void => {
    if (choice.ended) return;
    const status = finishReason === 'length' ? 'incomplete' : 'completed';
    closeReasoning(choice, status);
    closeMessage(choice, status);
    const nativeCandidate = nativeAccumulator.candidate(wireIndex);
    const nativeParts = klona(nativeCandidate?.content?.parts ?? []);
    choice.partsFieldState.length = nativeParts.length;
    options.roundTrip.onAssistantTurn(
      choice.irIndex,
      [{ role: 'model', parts: nativeParts }],
      [{ parts: choice.partsFieldState }],
      choice.idlessCallItemIndices.length > 0 ? choice.idlessCallItemIndices : undefined,
    );
    ir.choice(choice.irIndex).end(finishReason);
    choice.finishReason = finishReason;
    choice.ended = true;
  };

  const finishStream = function* (): Generator<IRRecord> {
    if (!started || !completion.isComplete()) {
      throw new Error(GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE);
    }
    const anyIncomplete = [...choices.values()].some(choice => choice.finishReason === 'length');
    ir.event({ type: 'finish', status: anyIncomplete ? 'incomplete' : 'completed' });
    yield* ir.drain();
  };

  for await (const frame of frames) {
    if (frame.type === 'done') {
      yield* finishStream();
      return;
    }
    const event = frame.event;
    if ('error' in event) {
      ir.event({ type: 'error', error: geminiGenerateContentErrorPayloadFromWire(event) });
      yield* ir.drain();
      return;
    }

    ensureStarted(event);
    if (event.usageMetadata !== undefined) assignUsage(event.usageMetadata);

    if (event.promptFeedback?.blockReason !== undefined) {
      nativeAccumulator.accept(event);
      const choice = choiceState(0);
      ir.choice(choice.irIndex).assign('refusal_details', {
        category: event.promptFeedback.blockReason,
        explanation: event.promptFeedback.blockReasonMessage ?? null,
      });
      endChoice(0, choice, 'content_filter');
      ir.event({ type: 'finish', status: 'completed' });
      yield* ir.drain();
      return;
    }

    const activeCandidates = (event.candidates ?? []).filter(candidate => !choices.get(candidate.index ?? 0)?.ended);
    if (activeCandidates.length > 0 || (event.candidates?.length ?? 0) === 0) {
      nativeAccumulator.accept(
        activeCandidates.length === (event.candidates?.length ?? 0)
          ? event
          : { ...event, candidates: activeCandidates },
      );
    }
    completion.observe(event);

    for (const candidate of activeCandidates) {
      const wireIndex = candidate.index ?? 0;
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
      if (isGeminiGenerateContentTerminalFinishReason(candidate.finishReason) && FAILED_OUTPUT_FINISH_REASONS[candidate.finishReason]) {
        ir.event({
          type: 'error',
          error: {
            message: `Gemini ended the response with ${candidate.finishReason}${candidate.finishMessage === undefined ? '' : `: ${candidate.finishMessage}`}`,
            type: 'server_error',
            code: candidate.finishReason,
          },
        });
        yield* ir.drain();
        return;
      }
      if (isGeminiGenerateContentTerminalFinishReason(candidate.finishReason)) {
        const mapped = mapFinishReason(candidate.finishReason, choice.hasToolCalls);
        if (candidate.finishMessage !== undefined || mapped === 'content_filter') {
          ir.choice(choice.irIndex).assign('refusal_details', {
            category: mapped === 'content_filter' ? candidate.finishReason : null,
            explanation: candidate.finishMessage ?? null,
          });
        }
        endChoice(wireIndex, choice, mapped);
      }
    }

    yield* ir.drain();
  }

  yield* finishStream();
};
