import { klona } from 'klona/json';

import type { GeminiGenerateContentInputAssistantTurnState } from './assistant-turn.ts';
import { usageToIR } from './usage.ts';
import type { ToolNameContext } from '../../../composition/request/tool-names.ts';
import { createIRBuilder, type IRItemHandle, type IRPartHandle } from '../../../ir/output/builder.ts';
import type { IRRecord } from '../../../ir/output/records.ts';
import type { IROutputSourceCitation, IROutputTokenLogprob } from '../../../ir/output/types.ts';
import type { RoundTripReader } from '../../../round-trip/reader.ts';
import { appendReadField, createReadFieldState, type ReadFieldStates } from '../../../round-trip/reference/reference-builder.ts';
import { errorPayloadFromWire } from '../../../shared/api-error.ts';
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
  record: TextPartRecord,
  startByte: number | undefined,
  endByte: number | undefined,
): { start: number; end_exclusive: number } | undefined => {
  // Proto3 JSON omits default zero values like `startIndex: 0`.
  if (endByte === undefined) return undefined;
  record.coordinateIndex ??= TextCoordinateIndex.utf8ToUTF16(record.text);
  record.coordinateIndex.assertUTF16Length(record.text.length);
  try {
    return record.coordinateIndex.utf8RangeToUTF16(startByte ?? 0, endByte);
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
  readonly annotations: IROutputSourceCitation[];
  text: string;
  coordinateIndex?: TextCoordinateIndex;
}

interface GeminiChoiceState {
  message?: IRItemHandle | undefined;
  textPart?: IRPartHandle | undefined;
  currentTextPartNativeIndex?: number | undefined;
  reasoning?: IRItemHandle | undefined;
  readonly partsFieldState: PartsFieldState;
  readonly syntheticCallIds: Record<number, string>;
  readonly textPartsByNativeIndex: Map<number, TextPartRecord>;
  nativePartCount: number;
  lastPartMergeableText: boolean;
  hasToolCalls: boolean;
  logprobGroups: number;
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
  // Gemini may omit `functionCall.id`. Indices alone repeat on every turn, so
  // a short per-response prefix keeps synthesized call ids unique across a
  // conversation while staying within downstream 40-char client limits, and
  // `syntheticCallIds` links later answers back to the id-less part on replay.
  const syntheticCallIdPrefix = `gc_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const namingOf = (wireName: string) => options.originalToolNames?.get(wireName) ?? { name: wireName };
  const nativeAccumulator = createGeminiGenerateContentEventAccumulator();
  const completion = createGeminiGenerateContentCandidateCompletion();
  const choices = new Map<number, GeminiChoiceState>();
  let started = false;
  let currentModel: string | undefined;

  const choiceState = (index: number): GeminiChoiceState => {
    let state = choices.get(index);
    if (state === undefined) {
      state = {
        partsFieldState: [],
        syntheticCallIds: {},
        textPartsByNativeIndex: new Map(),
        nativePartCount: 0,
        lastPartMergeableText: false,
        hasToolCalls: false,
        logprobGroups: 0,
        ended: false,
      };
      choices.set(index, state);
    }
    return state;
  };

  const closeTextPart = (choice: GeminiChoiceState): void => {
    if (choice.textPart === undefined) return;
    choice.textPart.end();
    choice.textPart = undefined;
    choice.currentTextPartNativeIndex = undefined;
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
    ir.choice(0);
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
    // Gemini may send cumulative groundingMetadata snapshots across frames; replace per touched partIndex.
    const nextByPart = new Map<number, IROutputSourceCitation[]>();
    for (const support of metadata.groundingSupports ?? []) {
      const partIndex = support.segment?.partIndex ?? 0;
      const record = choice.textPartsByNativeIndex.get(partIndex);
      if (record === undefined) continue;
      if (!record.part.isOpen) {
        console.warn('Dropping Gemini GenerateContent grounding citation for closed text part', { choice: choiceIndex, partIndex });
        continue;
      }
      const range = utf8ByteRangeToUTF16(record, support.segment?.startIndex, support.segment?.endIndex);
      for (const chunkIndex of support.groundingChunkIndices ?? []) {
        const chunk = chunks[chunkIndex];
        if (chunk === undefined) continue;
        const citation = groundingChunkToCitation(chunk, range);
        if (citation === undefined) continue;
        let list = nextByPart.get(partIndex);
        if (list === undefined) {
          list = [];
          nextByPart.set(partIndex, list);
        }
        list.push(citation);
      }
    }
    for (const [partIndex, citations] of nextByPart) {
      const record = choice.textPartsByNativeIndex.get(partIndex);
      if (record === undefined || citations.length === 0) continue;
      record.annotations.splice(0, record.annotations.length, ...citations);
      record.part.assign('annotations', [...record.annotations]);
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
    if (choice.logprobGroups === 0) handle.initialize('logprobs', []);
    const groupIndex = choice.logprobGroups++;
    handle.initialize(['logprobs', groupIndex], { scope: 'choice', tokens: [] });
    tokens.forEach((token, tokenIndex) => {
      handle.assign(['logprobs', groupIndex, 'tokens', tokenIndex], token);
    });
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
        if (choice.textPart === undefined || !mergedIntoPrevious || choice.currentTextPartNativeIndex === undefined) {
          closeTextPart(choice);
          choice.textPart = choice.message.part({ type: 'text', text: '' });
          choice.currentTextPartNativeIndex = partIndex;
          choice.textPartsByNativeIndex.set(partIndex, { part: choice.textPart, annotations: [], text: '' });
        }
        const existingState = choice.partsFieldState[partIndex];
        const existingTextField = existingState !== undefined && 'text' in existingState ? existingState.text : undefined;
        const textField = existingTextField ?? createReadFieldState('text');
        if (existingTextField === undefined) choice.partsFieldState[partIndex] = { text: textField };
        const pieceId = appendReadField(options.roundTrip.builder, textField, part.text);
        choice.textPart.append('text', part.text, [pieceId]);
        const record = choice.textPartsByNativeIndex.get(partIndex);
        if (record !== undefined) {
          record.text += part.text;
          record.coordinateIndex?.append(part.text);
        }
      } else if (!mergeable && choice.currentTextPartNativeIndex !== undefined) {
        // Defer closing the active IR text part until message end so trailing
        // groundingMetadata for that part can still attach annotations after a
        // standalone signature carrier (e.g. `{ text: '', thoughtSignature }`).
        choice.currentTextPartNativeIndex = undefined;
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
      let callId: string;
      if (typeof call.id === 'string' && call.id !== '') {
        callId = call.id;
      } else {
        callId = `${syntheticCallIdPrefix}_${choiceIndex}_${partIndex}`;
        choice.syntheticCallIds[partIndex] = callId;
      }
      const argsObject = requireJSONObject(call.args ?? {});
      const argsJson = JSON.stringify(argsObject);
      const naming = namingOf(call.name);
      const isCustom = options.customToolNames?.has(call.name) === true;

      if (isCustom) {
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
      closeReasoning(choice);
      closeTextPart(choice);
      choice.message ??= ir.item(choiceIndex, { type: 'message', content: [] });
      const dataField = createReadFieldState('text');
      const dataPieceId = appendReadField(options.roundTrip.builder, dataField, part.inlineData.data);

      if (part.inlineData.mimeType.startsWith('audio/') || part.audioTranscription !== undefined) {
        const audioPart = choice.message.part({
          type: 'audio',
          audio: {
            media_type: part.inlineData.mimeType,
            data: '',
            ...(part.audioTranscription === undefined ? {} : { transcript: '' }),
          },
        });
        if (part.inlineData.data !== '') {
          audioPart.append(['audio', 'data'], part.inlineData.data, [dataPieceId]);
        }
        if (part.audioTranscription !== undefined) {
          const transcriptField = createReadFieldState('text');
          const transcriptPieceId = appendReadField(options.roundTrip.builder, transcriptField, part.audioTranscription.text);
          if (part.audioTranscription.text !== '') {
            audioPart.append(['audio', 'transcript'], part.audioTranscription.text, [transcriptPieceId]);
          }
          choice.partsFieldState[partIndex] = {
            inlineData: { data: dataField },
            audioTranscription: { text: transcriptField },
          };
        } else {
          choice.partsFieldState[partIndex] = { inlineData: { data: dataField } };
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
        choice.partsFieldState[partIndex] = { inlineData: { data: dataField } };
        imagePart.end();
      }
    }
  };

  const endChoice = (
    choiceIndex: number,
    choice: GeminiChoiceState,
    finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter',
  ): void => {
    if (choice.ended) return;
    const status = finishReason === 'length' ? 'incomplete' : 'completed';
    closeReasoning(choice, status);
    closeMessage(choice, status);
    const nativeCandidate = nativeAccumulator.candidate(choiceIndex);
    const nativeParts = klona(nativeCandidate?.content?.parts ?? []);
    choice.partsFieldState.length = nativeParts.length;
    const hasSyntheticCalls = Object.keys(choice.syntheticCallIds).length > 0;
    options.roundTrip.onAssistantTurn(
      choiceIndex,
      [{
        role: 'model',
        parts: nativeParts,
        ...(hasSyntheticCalls ? { syntheticCallIds: { ...choice.syntheticCallIds } } : {}),
      }],
      [{ parts: choice.partsFieldState }],
    );
    ir.choice(choiceIndex).end(finishReason);
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
      ir.event({ type: 'error', error: errorPayloadFromWire(event) });
      yield* ir.drain();
      return;
    }

    ensureStarted(event);
    if (event.usageMetadata !== undefined) assignUsage(event.usageMetadata);

    if (event.promptFeedback?.blockReason !== undefined) {
      nativeAccumulator.accept(event);
      const choice = choiceState(0);
      ir.choice(0).assign('refusal_details', {
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
      const choiceIndex = candidate.index ?? 0;
      const choice = choiceState(choiceIndex);
      ir.choice(choiceIndex);

      for (const part of candidate.content?.parts ?? []) {
        readPart(choiceIndex, choice, part);
      }
      if (candidate.groundingMetadata !== undefined) {
        applyGroundingMetadata(choiceIndex, choice, candidate.groundingMetadata);
      }
      if (candidate.logprobsResult !== undefined) {
        applyLogprobs(choiceIndex, choice, candidate);
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
          ir.choice(choiceIndex).assign('refusal_details', {
            category: mapped === 'content_filter' ? candidate.finishReason : null,
            explanation: candidate.finishMessage ?? null,
          });
        }
        endChoice(choiceIndex, choice, mapped);
      }
    }

    yield* ir.drain();
  }

  yield* finishStream();
};
