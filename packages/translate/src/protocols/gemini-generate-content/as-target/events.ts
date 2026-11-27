import type { GeminiGenerateContentInputAssistantTurnState } from './assistant-turn.ts';
import { geminiGenerateContentErrorPayloadFromWire } from './error.ts';
import { usageToIR, type GeminiGenerateContentUsageAccumulator } from './usage.ts';
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
import { generateContentServiceTierToIR } from '../service-tier.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import {
  GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE,
  appendGeminiGenerateContentPart,
  hasGeminiGenerateContentPartData,
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

// GenerateContent finish reasons indicating safety or policy filtering.
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

// GenerateContent finish reasons meaning the model's own output was unusable.
// Surface them as a stream error so an agent loop observes the failure.
// https://ai.google.dev/api/generate-content#FinishReason
const FAILED_OUTPUT_FINISH_REASONS: ReadonlySet<string> = new Set([
  'MALFORMED_FUNCTION_CALL',
  'UNEXPECTED_TOOL_CALL',
  'TOO_MANY_TOOL_CALLS',
  'MISSING_THOUGHT_SIGNATURE',
  'MALFORMED_RESPONSE',
]);

const mapFinishReason = (
  finishReason: GeminiGenerateContentFinishReason,
  hasToolCalls: boolean,
): 'stop' | 'length' | 'tool_calls' | 'content_filter' => {
  if (finishReason === 'MAX_TOKENS') return 'length';
  if (CONTENT_FILTER_FINISH_REASONS.has(finishReason)) return 'content_filter';
  if (hasToolCalls && finishReason === 'STOP') return 'tool_calls';
  return 'stop';
};

type PartsFieldState = NonNullable<NonNullable<GeminiGenerateContentInputAssistantTurnState<ReadFieldStates>[number]>['parts']>;

interface TextRun {
  readonly part: IRPartHandle;
  readonly logicalIndex: number;
  text: string;
  coordinateIndex?: TextCoordinateIndex;
  readonly citations: IROutputSourceCitation[];
  readonly citationKeys: Set<string>;
}

interface GenerateContentChoiceState {
  readonly irIndex: number;
  message?: IRItemHandle | undefined;
  activeTextRun?: TextRun | undefined;
  readonly textRuns: TextRun[];
  reasoning?: IRItemHandle | undefined;
  readonly nativeParts: GeminiGenerateContentPart[];
  readonly partsFieldState: PartsFieldState;
  logicalPartCount: number;
  inThought: boolean;
  hasToolCalls: boolean;
  logprobTokenCount: number;
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  ended: boolean;
}

const ensureRunIndex = (run: TextRun): TextCoordinateIndex => {
  run.coordinateIndex ??= TextCoordinateIndex.utf8ToUTF16(run.text);
  run.coordinateIndex.assertUTF16Length(run.text.length);
  return run.coordinateIndex;
};

// GenerateContent omits `partIndex` (proto3 default `0`) and computes `startIndex`/`endIndex`
// as UTF-8 byte offsets across all concatenated visible text parts, even after thought or
// server-side tool parts. Honor an explicit non-zero `partIndex` against logical part indices
// when present, and otherwise locate the owning run in concatenated visible UTF-8.
// https://ai.google.dev/api/generate-content#Segment
// https://github.com/googleapis/python-genai/issues/961#issuecomment-3134170829
const resolveGroundingTarget = (
  choice: GenerateContentChoiceState,
  segmentSpec: NonNullable<NonNullable<GeminiGenerateContentGroundingMetadata['groundingSupports']>[number]['segment']> | undefined,
): { readonly run: TextRun; readonly baseByte: number } | undefined => {
  const partIndex = segmentSpec?.partIndex ?? 0;
  if (partIndex !== 0) {
    const byLogical = choice.textRuns.find(run => run.logicalIndex === partIndex);
    return byLogical === undefined ? undefined : { run: byLogical, baseByte: 0 };
  }
  if (choice.textRuns.length === 0) return undefined;
  if (choice.textRuns.length === 1) return { run: choice.textRuns[0], baseByte: 0 };

  const endByte = segmentSpec?.endIndex;
  if (endByte === undefined) {
    return { run: choice.activeTextRun ?? choice.textRuns[0], baseByte: 0 };
  }
  const startByte = segmentSpec?.startIndex ?? 0;
  if (!Number.isInteger(startByte) || !Number.isInteger(endByte) || startByte < 0 || endByte <= startByte) {
    return { run: choice.textRuns[0], baseByte: 0 };
  }
  let offset = 0;
  for (const run of choice.textRuns) {
    const length = ensureRunIndex(run).utf8Length;
    if (startByte < offset + length) return { run, baseByte: offset };
    offset += length;
  }
  const last = choice.textRuns.at(-1)!;
  return { run: last, baseByte: offset - ensureRunIndex(last).utf8Length };
};

// Proto3 JSON omits default zero values like `startIndex: 0` and `partIndex: 0`.
// https://protobuf.dev/programming-guides/json/#field-presence
const utf8ByteRangeToUTF16 = (
  choiceIndex: number,
  run: TextRun,
  baseByte: number,
  startByte: number | undefined,
  endByte: number | undefined,
): { start: number; end_exclusive: number } | undefined => {
  if (endByte === undefined) return undefined;
  const rawStart = startByte ?? 0;
  if (!Number.isInteger(rawStart) || !Number.isInteger(endByte) || rawStart < 0 || endByte <= rawStart) {
    console.warn('Dropping Gemini GenerateContent grounding range with invalid byte bounds', { choice: choiceIndex, startByte: rawStart, endByte });
    return undefined;
  }
  const index = ensureRunIndex(run);
  const availableBytes = index.utf8Length;
  const localStart = rawStart - baseByte;
  const localEnd = endByte - baseByte;
  const clampedStart = Math.min(localStart, availableBytes);
  const clampedEnd = Math.min(localEnd, availableBytes);
  if (localEnd > availableBytes) {
    console.warn(
      clampedStart >= clampedEnd
        ? 'Dropping Gemini GenerateContent grounding range outside streamed text'
        : 'Clamping Gemini GenerateContent grounding range to streamed text',
      { choice: choiceIndex, startByte: rawStart, endByte, availableBytes: baseByte + availableBytes },
    );
  }
  if (clampedStart >= clampedEnd) return undefined;
  try {
    return index.utf8RangeToUTF16(clampedStart, clampedEnd);
  } catch (error) {
    if (error instanceof RangeError) {
      console.warn('Dropping Gemini GenerateContent grounding range that splits a UTF-8 character', {
        choice: choiceIndex,
        startByte: baseByte + clampedStart,
        endByte: baseByte + clampedEnd,
      });
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

export const readGeminiGenerateContentEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>,
  options: Partial<ToolNameContext> & {
    readonly fallbackModel?: string;
    readonly roundTrip: RoundTripReader<'geminiGenerateContent'>;
  },
): AsyncGenerator<IRRecord> {
  const ir = createIRBuilder();
  const namingOf = (wireName: string) => options.originalToolNames?.get(wireName) ?? { name: wireName };
  const choices = new Map<number, GenerateContentChoiceState>();
  const usageAccumulator: GeminiGenerateContentUsageAccumulator = {};
  let nextIRChoiceIndex = 0;
  let started = false;
  let hasModel = false;

  const choiceState = (wireIndex: number): GenerateContentChoiceState => {
    let state = choices.get(wireIndex);
    if (state === undefined) {
      state = {
        irIndex: nextIRChoiceIndex++,
        textRuns: [],
        nativeParts: [],
        partsFieldState: [],
        logicalPartCount: 0,
        inThought: false,
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

  const closeTextPart = (choice: GenerateContentChoiceState): void => {
    if (choice.activeTextRun === undefined) return;
    choice.activeTextRun.part.end();
    choice.activeTextRun = undefined;
  };

  const closeMessage = (choice: GenerateContentChoiceState, status: 'completed' | 'incomplete' = 'completed'): void => {
    closeTextPart(choice);
    if (choice.message === undefined) return;
    choice.message.end(status);
    choice.message = undefined;
  };

  const closeReasoning = (choice: GenerateContentChoiceState, status: 'completed' | 'incomplete' = 'completed'): void => {
    if (choice.reasoning === undefined) return;
    choice.reasoning.end(status);
    choice.reasoning = undefined;
  };

  const assignUsage = (usage: GeminiGenerateContentUsageMetadata): void => {
    ir.usage(usageToIR(usage, usageAccumulator));
    const tier = generateContentServiceTierToIR(typeof usage.serviceTier === 'string' ? usage.serviceTier : undefined);
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

  const applyGroundingMetadata = (choiceIndex: number, choice: GenerateContentChoiceState, metadata: GeminiGenerateContentGroundingMetadata): void => {
    const chunks = metadata.groundingChunks ?? [];
    if (chunks.length === 0) return;
    const touched = new Set<TextRun>();
    for (const support of metadata.groundingSupports ?? []) {
      const target = resolveGroundingTarget(choice, support.segment);
      if (target === undefined) continue;
      const { run, baseByte } = target;
      const warnClosedPart = (): void => {
        console.warn('Dropping Gemini GenerateContent grounding citation for closed text part', {
          choice: choiceIndex,
          partIndex: support.segment?.partIndex ?? 0,
        });
      };
      if (!run.part.isOpen && run.citationKeys.size === 0) {
        warnClosedPart();
        continue;
      }
      const range = utf8ByteRangeToUTF16(choiceIndex, run, baseByte, support.segment?.startIndex, support.segment?.endIndex);
      for (const chunkIndex of support.groundingChunkIndices ?? []) {
        const chunk = chunks[chunkIndex];
        if (chunk === undefined) continue;
        const citation = groundingChunkToCitation(chunk, range);
        if (citation === undefined) continue;
        // Keep `annotations` append-only across cumulative snapshots so streaming
        // consumers (such as Responses) never skip or duplicate earlier entries.
        const key = JSON.stringify(citation);
        if (run.citationKeys.has(key)) continue;
        if (!run.part.isOpen) {
          warnClosedPart();
          break;
        }
        run.citationKeys.add(key);
        run.citations.push(citation);
        touched.add(run);
      }
    }
    for (const run of touched) {
      run.part.assign('annotations', [...run.citations]);
    }
  };

  const applyLogprobs = (choiceIndex: number, choice: GenerateContentChoiceState, candidate: GeminiGenerateContentCandidate): void => {
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

  const readPart = (choiceIndex: number, choice: GenerateContentChoiceState, part: GeminiGenerateContentPart): void => {
    const partIndex = appendGeminiGenerateContentPart(choice.nativeParts, part);

    if (part.thought === true) {
      closeTextPart(choice);
      if (!choice.inThought) {
        choice.logicalPartCount++;
        choice.inThought = true;
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
      let run = choice.activeTextRun;
      if (run === undefined) {
        run = {
          part: choice.message.part({ type: 'text', text: '' }),
          logicalIndex: choice.logicalPartCount++,
          text: '',
          citations: [],
          citationKeys: new Set(),
        };
        choice.inThought = false;
        choice.activeTextRun = run;
        choice.textRuns.push(run);
      }
      const existingState = choice.partsFieldState[partIndex];
      const existingTextField = existingState !== undefined && 'text' in existingState ? existingState.text : undefined;
      const textField = existingTextField ?? createReadFieldState('text');
      if (existingTextField === undefined) choice.partsFieldState[partIndex] = { text: textField };
      appendTextField(run.part, 'text', part.text, textField);
      run.text += part.text;
      run.coordinateIndex?.append(part.text);
      return;
    }

    if (part.functionCall !== undefined) {
      choice.logicalPartCount++;
      choice.inThought = false;
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
      closeTextPart(choice);
      choice.logicalPartCount++;
      choice.inThought = false;
      const mimeType = part.inlineData.mimeType.toLowerCase();
      const isAudio = mimeType.startsWith('audio/') || part.audioTranscription !== undefined;
      const isImage = !isAudio && mimeType.startsWith('image/');
      if (!isAudio && !isImage) return;
      closeReasoning(choice);
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

    if (hasGeminiGenerateContentPartData(part)) {
      closeTextPart(choice);
      choice.logicalPartCount++;
      choice.inThought = false;
    }
  };

  const endChoice = (
    choice: GenerateContentChoiceState,
    finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter',
  ): void => {
    if (choice.ended) return;
    const status = finishReason === 'length' ? 'incomplete' : 'completed';
    closeReasoning(choice, status);
    closeMessage(choice, status);
    choice.partsFieldState.length = choice.nativeParts.length;
    options.roundTrip.onAssistantTurn(
      choice.irIndex,
      [{ role: 'model', parts: choice.nativeParts }],
      [{ parts: choice.partsFieldState }],
    );
    ir.choice(choice.irIndex).end(finishReason);
    choice.finishReason = finishReason;
    choice.ended = true;
  };

  const finishStatus = (): 'completed' | 'incomplete' =>
    [...choices.values()].some(choice => choice.finishReason === 'length') ? 'incomplete' : 'completed';

  const finishStream = function* (): Generator<IRRecord> {
    if (!started || choices.size === 0 || [...choices.values()].some(choice => !choice.ended)) {
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
        message: `GenerateContent ended the response with ${finishReason}${suffix}`,
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
