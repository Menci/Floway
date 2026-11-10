import { collectOpenAIChatCompletionsTextViews, computeOpenAIChatCompletionsTurnDigest, createOpenAIChatCompletionsSidecarCarrier } from './round-trip.ts';
import { usageFromIR } from './usage.ts';
import { irItemPath, irPartPath, irPathKey } from '../../../ir/operation-paths.ts';
import { createIROrdinalMapper } from '../../../ir/ordinal-mapper.ts';
import { consumeIRRecords, type IRRecord } from '../../../ir/stream.ts';
import { IRAbsent, type IRErrorPayload, type IRItem, type IRMessageItem, type IRTokenLogprob } from '../../../ir/types.ts';
import { appendContent, createContentState, type ContentStates, type ContentState } from '../../../round-trip/reference/reference-builder.ts';
import { provenanceSpanForAppend, replayTextProvenance, type TextProvenanceSpan } from '../../../round-trip/reference/text-provenance.ts';
import type { RoundTripOutputOptions } from '../../../round-trip/stream.ts';
import { TextCoordinateIndex } from '../../../shared/text-coordinate-index.ts';
import { toOpenAIChatCompletionsInputAssistantTurn, type OpenAIChatCompletionsOutputAssistantState } from '../as-target/assistant-turn.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import {
  type OpenAIChatCompletionsAnnotation,
  type OpenAIChatCompletionsAssistantDeltaEx,
  type OpenAIChatCompletionsStreamEvent,
  type OpenAIChatCompletionsTokenLogprob,
  type OpenAIChatCompletionsUsageEx,
  createOpenAIChatCompletionsEventAccumulator,
} from '@floway-dev/protocols/openai-chat-completions';

const irChatError = (error: IRErrorPayload): IRErrorPayload => ({
  message: error.message,
  type: typeof error.type === 'string' && error.type !== 'error' ? error.type : error.code ?? 'server_error',
  ...(error.code === undefined ? {} : { code: error.code }),
  ...(error.param === undefined ? {} : { param: error.param }),
  ...(error.provider_specific_fields === undefined ? {} : { provider_specific_fields: error.provider_specific_fields }),
});

interface OpenAIChatCompletionsSSEOutputOptions extends RoundTripOutputOptions<'openaiChatCompletions'> {
  // Replay identity belongs to the newly emitted target audio, not the source IR content.
  audioMetadata?: (choice: number) => { id: string; expires_at: number };
  continuousUsageStats?: boolean;
}

const tierFields = (tier?: string): { service_tier?: string } => tier === undefined ? {} : { service_tier: tier };

type IRToolCallItem = Extract<IRItem, { type: 'function_call' | 'custom_tool_call' }>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isIRItem = (value: unknown): value is IRItem => {
  if (!isRecord(value)) return false;
  switch (value.type) {
  case 'message': return Array.isArray(value.content);
  case 'reasoning': return true;
  case 'function_call': return typeof value.name === 'string' && typeof value.arguments === 'string';
  case 'custom_tool_call': return typeof value.name === 'string' && typeof value.input === 'string';
  default: return false;
  }
};

const partType = (value: unknown): IRMessageItem['content'][number]['type'] | undefined => {
  if (!isRecord(value)) return undefined;
  return value.type === 'text' || value.type === 'refusal' || value.type === 'image' || value.type === 'audio' ? value.type : undefined;
};

type LogprobMetadata = { readonly scope: 'choice' } | {
  readonly scope: 'text_part';
  readonly item_index: number;
  readonly content_index: number;
};

const logprobMetadata = (value: unknown): LogprobMetadata | undefined => {
  if (!isRecord(value)) return undefined;
  if (value.scope === 'choice') return { scope: 'choice' };
  if (value.scope === 'text_part' && typeof value.item_index === 'number' && typeof value.content_index === 'number') {
    return { scope: 'text_part', item_index: value.item_index, content_index: value.content_index };
  }
  return undefined;
};

const isIRTokenLogprob = (value: unknown): value is IRTokenLogprob =>
  isRecord(value) && typeof value.token === 'string' && typeof value.logprob === 'number';

// Emitted deltas carry the assistant extension fields (reasoning, annotations) beside the standard ones.
type ChatChoiceChunk = Omit<OpenAIChatCompletionsStreamEvent['choices'][number], 'delta'> & { delta: OpenAIChatCompletionsAssistantDeltaEx };
type ChatChunkFields = Partial<Pick<OpenAIChatCompletionsStreamEvent, 'service_tier' | 'usage'>>;
type ChatTextField = 'content' | 'refusal' | 'reasoning_text';

export const openaiChatCompletionsFromIR = async function* (
  records: AsyncIterable<IRRecord>,
  options: OpenAIChatCompletionsSSEOutputOptions,
): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  let metadata = { id: '', model: '', created: 0 };
  let started = false;
  const startedChoices = new Set<number>();
  const tools = new Map<number, ReturnType<typeof createIROrdinalMapper>>();
  const startedAudio = new Set<string>();
  const itemTypes = new Map<string, IRItem['type']>();
  const partTypes = new Map<string, IRMessageItem['content'][number]['type']>();
  const logprobRefusal = new Map<string, boolean>();
  const nativeAccumulators = new Map<number, ReturnType<typeof createOpenAIChatCompletionsEventAccumulator>>();
  const nativeAccumulator = (choice: number): ReturnType<typeof createOpenAIChatCompletionsEventAccumulator> => {
    let accumulator = nativeAccumulators.get(choice);
    if (accumulator === undefined) {
      accumulator = createOpenAIChatCompletionsEventAccumulator();
      nativeAccumulators.set(choice, accumulator);
    }
    return accumulator;
  };
  const outputStates = new Map<number, OpenAIChatCompletionsOutputAssistantState<ContentStates>>();
  const pendingTranscripts = new Map<string, TextProvenanceSpan[]>();
  let usage: OpenAIChatCompletionsUsageEx | undefined;

  const outputState = (choice: number): OpenAIChatCompletionsOutputAssistantState<ContentStates> => {
    let state = outputStates.get(choice);
    if (state === undefined) {
      state = {};
      outputStates.set(choice, state);
    }
    return state;
  };
  const textState = (choice: number, field: ChatTextField): ContentState<'text'> => {
    const state = outputState(choice);
    return state[field] ??= createContentState(options.roundTrip.builder, 'text');
  };
  const toolState = (choice: number, ordinal: number, custom: boolean): ContentState<'text'> => {
    const choiceState = outputState(choice);
    const toolCalls = choiceState.tool_calls ??= [];
    const current = toolCalls[ordinal];
    if (current !== undefined) {
      if (custom && 'custom' in current && current.custom?.input !== undefined) return current.custom.input;
      if (!custom && 'function' in current && current.function?.arguments !== undefined) return current.function.arguments;
      throw new TypeError(`ChatCompletions tool state kind changed at ordinal ${ordinal}`);
    }
    const state = createContentState(options.roundTrip.builder, 'text');
    toolCalls[ordinal] = custom ? { custom: { input: state } } : { function: { arguments: state } };
    return state;
  };

  // Continuous usage is cumulative metadata on emitted choice chunks.
  // https://github.com/vllm-project/vllm/blob/d5f0a6e829faa69d1db289bf62b14dae136c02b2/vllm/entrypoints/openai/chat_completion/serving.py#L798-L871
  const chunk = (choices: ChatChoiceChunk[], fields: ChatChunkFields = {}): ProtocolFrame<OpenAIChatCompletionsStreamEvent> => {
    const event: OpenAIChatCompletionsStreamEvent = {
      id: metadata.id,
      object: 'chat.completion.chunk',
      model: metadata.model,
      created: metadata.created,
      choices,
      ...(options.continuousUsageStats && choices.length > 0 ? { usage: usage ?? null } : {}),
      ...fields,
    };
    for (const choice of choices) nativeAccumulator(choice.index).accept({ ...event, choices: [choice] });
    return eventFrame(event);
  };
  const deltaFrame = (
    choice: number,
    delta: OpenAIChatCompletionsAssistantDeltaEx,
    tier?: string,
  ): ProtocolFrame<OpenAIChatCompletionsStreamEvent> => chunk([{ index: choice, delta, finish_reason: null }], tierFields(tier));
  const ensureChoice = (choice: number, tier?: string): ProtocolFrame<OpenAIChatCompletionsStreamEvent> | undefined => {
    if (startedChoices.has(choice)) return undefined;
    startedChoices.add(choice);
    tools.set(choice, createIROrdinalMapper());
    return deltaFrame(choice, { role: 'assistant', content: '' }, tier);
  };

  // The first delta of a tool call, which also names it. The call ID falls back to one derived from the item position.
  const toolCallStart = (
    choice: number,
    itemIndex: number,
    item: IRToolCallItem,
    ordinal: number,
    tier?: string,
  ): ProtocolFrame<OpenAIChatCompletionsStreamEvent> => {
    const callId = item.call_id === undefined || item.call_id === IRAbsent ? `${metadata.id}_${choice}_${itemIndex}` : item.call_id;
    const call = item.type === 'custom_tool_call'
      ? { index: ordinal, id: callId, type: 'custom' as const, custom: { name: item.name } }
      : { index: ordinal, id: callId, type: 'function' as const, function: { name: item.name } };
    return deltaFrame(choice, { tool_calls: [call] }, tier);
  };

  for await (const { record, collector } of consumeIRRecords(records)) {
    const { state } = collector;
    if (record.type === 'error') {
      yield eventFrame({ error: irChatError(record.error) } as unknown as OpenAIChatCompletionsStreamEvent);
      return;
    }
    if (record.type === 'write' && record.path[0] === 'model' && typeof record.value === 'string') metadata.model = record.value;
    if (record.type === 'write' && record.path[0] === 'usage') usage = state.usage === undefined ? undefined : usageFromIR(state.usage);
    if (record.type === 'start') {
      if (state.model === undefined) throw new TypeError('ChatCompletions output requires an IR model before start');
      const id = options.id ?? record.id;
      metadata = {
        id: id === undefined || id === '' ? `chatcmpl-${crypto.randomUUID()}` : id,
        model: state.model,
        created: record.created ?? options.created ?? Math.floor(Date.now() / 1000),
      };
      started = true;
      for (let choice = 0; choice < state.choices.length; choice++) {
        const opening = ensureChoice(choice, state.service_tier);
        if (opening !== undefined) yield opening;
      }
      continue;
    }
    if (!started) continue;
    const tier = state.service_tier;

    if (record.type === 'write'
      && record.kind === 'initialize'
      && record.path.length === 2
      && record.path[0] === 'choices'
      && typeof record.path[1] === 'number') {
      const opening = ensureChoice(record.path[1], tier);
      if (opening !== undefined) yield opening;
      continue;
    }

    if (record.type === 'write' && record.path[0] === 'choices' && typeof record.path[1] === 'number') {
      const choice = record.path[1];
      const opening = ensureChoice(choice, tier);
      if (opening !== undefined) yield opening;
      const path = record.path;

      if (record.kind === 'initialize' && path.length === 4 && path[2] === 'items' && typeof path[3] === 'number') {
        if (!isIRItem(record.value)) throw new TypeError('ChatCompletions item initialization requires an item');
        const item = record.value;
        itemTypes.set(irPathKey(path), item.type);
        if (item.type === 'function_call' || item.type === 'custom_tool_call') {
          yield toolCallStart(choice, path[3], item, tools.get(choice)!.open(path), tier);
        }
        continue;
      }

      if (record.kind === 'initialize'
        && path.length === 6
        && path[2] === 'items'
        && path[4] === 'content'
        && typeof path[5] === 'number'
        && itemTypes.get(irPathKey(path.slice(0, 4))) === 'message') {
        const type = partType(record.value);
        if (type === undefined) throw new TypeError('ChatCompletions part initialization requires a content part');
        partTypes.set(irPathKey(path), type);
        continue;
      }

      if (record.kind === 'initialize'
        && path.length === 4
        && path[2] === 'logprobs'
        && typeof path[3] === 'number') {
        const group = logprobMetadata(record.value);
        if (group === undefined) throw new TypeError('ChatCompletions logprob initialization requires a group');
        let refusal = false;
        if (group.scope === 'text_part') {
          const owner = irPartPath(choice, group.item_index, group.content_index);
          const partType = partTypes.get(irPathKey(owner));
          if (partType !== 'text' && partType !== 'refusal') throw new TypeError('Text-part logprobs require a text or refusal owner');
          refusal = partType === 'refusal';
        }
        logprobRefusal.set(`${choice}/${path[3]}`, refusal);
        continue;
      }

      if (record.kind === 'append') {
        if (path.length === 7 && path[2] === 'items' && path[4] === 'content' && (path[6] === 'text' || path[6] === 'refusal')) {
          appendContent(options.roundTrip.builder, textState(choice, path[6] === 'text' ? 'content' : 'refusal'), record.value, record.referencePieceIds);
          yield deltaFrame(choice, path[6] === 'text' ? { content: record.value } : { refusal: record.value }, tier);
          continue;
        }
        if (path.length === 8 && path[2] === 'items' && path[4] === 'content' && path[6] === 'audio' && (path[7] === 'data' || path[7] === 'transcript')) {
          const partPath = path.slice(0, 6);
          if (partTypes.get(irPathKey(partPath)) !== 'audio') throw new TypeError('ChatCompletions audio delta requires an audio part');
          const audioPath = irPathKey(partPath);
          if (path[7] === 'transcript' && !startedAudio.has(audioPath)) {
            const transcript = collector.value<string>(path);
            if (transcript === undefined) throw new Error('Missing ChatCompletions pending transcript');
            const parts = pendingTranscripts.get(audioPath) ?? [];
            parts.push(provenanceSpanForAppend(transcript, record.value, record.referencePieceIds));
            pendingTranscripts.set(audioPath, parts);
          }
          if (path[7] === 'data') {
            const audioMetadata = options.audioMetadata?.(choice);
            if (audioMetadata === undefined) throw new Error('ChatCompletions audio requires replay ID and expiry metadata');
            // The first native audio delta includes the transcript accumulated before data arrived.
            const item = state.choices[choice].items[path[3] as number];
            const part = item.type === 'message' ? item.content[path[5] as number] : undefined;
            if (part?.type !== 'audio') throw new TypeError('ChatCompletions audio delta requires an audio part');
            const first = !startedAudio.has(audioPath);
            startedAudio.add(audioPath);
            pendingTranscripts.delete(audioPath);
            const audio = { ...(first ? audioMetadata : {}), data: record.value, ...(first ? { transcript: part.audio.transcript ?? '' } : {}) };
            yield deltaFrame(choice, { audio }, tier);
          } else if (startedAudio.has(audioPath)) yield deltaFrame(choice, { audio: { transcript: record.value } }, tier);
          continue;
        }
        if (path.length === 6 && path[2] === 'items' && (path[4] === 'summary' || path[4] === 'content')) {
          appendContent(options.roundTrip.builder, textState(choice, 'reasoning_text'), record.value, record.referencePieceIds);
          yield deltaFrame(choice, { reasoning_text: record.value }, tier);
          continue;
        }
        if (path.length === 5 && path[2] === 'items' && (path[4] === 'arguments' || path[4] === 'input')) {
          const itemType = itemTypes.get(irPathKey(path.slice(0, 4)));
          if (itemType !== 'function_call' && itemType !== 'custom_tool_call') throw new TypeError('ChatCompletions tool delta requires a tool item');
          const ordinal = tools.get(choice)!.get(path.slice(0, 4));
          const custom = itemType === 'custom_tool_call';
          appendContent(options.roundTrip.builder, toolState(choice, ordinal, custom), record.value, record.referencePieceIds);
          const call = custom
            ? { index: ordinal, custom: { input: record.value } }
            : { index: ordinal, function: { arguments: record.value } };
          yield deltaFrame(choice, { tool_calls: [call] }, tier);
          continue;
        }
      }

      if (record.kind === 'assign' && path.length === 5 && path[2] === 'items' && (path[4] === 'name' || path[4] === 'call_id')) {
        // A late name or call ID must be paired with the other accumulated tool field.
        const item = state.choices[choice].items[path[3] as number];
        if (item.type !== 'function_call' && item.type !== 'custom_tool_call') throw new TypeError('ChatCompletions tool metadata requires a tool item');
        yield toolCallStart(choice, path[3] as number, item, tools.get(choice)!.get(path.slice(0, 4)), tier);
        continue;
      }

      if (record.kind === 'assign' && path[2] === 'logprobs' && typeof path[3] === 'number' && path[4] === 'tokens' && typeof path[5] === 'number') {
        // Upstream-compatible Chat logprobs may omit bytes and alternatives; preserve that shape.
        if (!isIRTokenLogprob(record.value)) throw new TypeError('ChatCompletions logprob token requires a token');
        const token = {
          token: record.value.token,
          logprob: record.value.logprob,
          ...(record.value.bytes === undefined ? {} : { bytes: record.value.bytes === null ? null : [...record.value.bytes] }),
          ...(record.value.top_logprobs === undefined ? {} : {
            top_logprobs: record.value.top_logprobs.map(alternative => ({
              token: alternative.token,
              logprob: alternative.logprob,
              ...(alternative.bytes === undefined ? {} : { bytes: alternative.bytes === null ? null : [...alternative.bytes] }),
            })),
          }),
        } as OpenAIChatCompletionsTokenLogprob;
        const refusal = logprobRefusal.get(`${choice}/${path[3]}`);
        if (refusal === undefined) throw new TypeError('ChatCompletions logprob token requires a group');
        const logprobs = { content: refusal ? null : [token], refusal: refusal ? [token] : null };
        yield chunk([{ index: choice, delta: {}, logprobs, finish_reason: null }], tierFields(tier));
        continue;
      }
    }

    if (record.type === 'item_end') {
      const path = irItemPath(record.choice, record.item);
      const itemType = itemTypes.get(irPathKey(path));
      if (itemType === 'function_call' || itemType === 'custom_tool_call') tools.get(record.choice)!.close(path);
      continue;
    }

    if (record.type === 'part_end') {
      const path = irPartPath(record.choice, record.item, record.part);
      if (partTypes.get(irPathKey(path)) !== 'audio') continue;
      // Transcript-only audio is emitted as text once the complete part is available.
      const item = state.choices[record.choice].items[record.item];
      const part = item.type === 'message' ? item.content[record.part] : undefined;
      if (part?.type === 'audio' && !startedAudio.has(irPathKey(path)) && part.audio.transcript !== undefined) {
        const content = textState(record.choice, 'content');
        replayTextProvenance(part.audio.transcript, pendingTranscripts.get(irPathKey(path)) ?? [], (value, referencePieceIds) => {
          appendContent(options.roundTrip.builder, content, value, referencePieceIds);
        });
        pendingTranscripts.delete(irPathKey(path));
        yield deltaFrame(record.choice, { content: part.audio.transcript }, tier);
      }
      continue;
    }

    if (record.type === 'choice_end') {
      const choice = state.choices[record.choice];
      let flattened = '';
      let coordinateIndex: TextCoordinateIndex | undefined;
      const annotations: OpenAIChatCompletionsAnnotation[] = [];
      choice.items.forEach(item => {
        if (item.type !== 'message') return;
        item.content.forEach(part => {
          if (part.type !== 'text') return;
          const base = flattened.length;
          flattened += part.text;
          coordinateIndex?.append(part.text);
          for (const annotation of part.annotations ?? []) {
            if (annotation.source_kind === 'document' || annotation.source == null) continue;
            if (annotation.output_text_range === undefined) continue;
            const range = annotation.output_text_range;
            coordinateIndex ??= TextCoordinateIndex.utf16ToCodePoints(flattened);
            coordinateIndex.assertUTF16Length(flattened.length);
            const offsets = coordinateIndex.irRangeToCodePoints({ start: base + range.start, end_exclusive: base + range.end_exclusive });
            annotations.push({
              type: 'url_citation',
              url_citation: { start_index: offsets.start, end_index: offsets.end, title: annotation.source_label ?? annotation.source, url: annotation.source },
            });
          }
        });
      });
      if (annotations.length > 0) yield deltaFrame(record.choice, { annotations }, tier);
      if (choice.refusal?.explanation != null) {
        appendContent(options.roundTrip.builder, textState(record.choice, 'refusal'), choice.refusal.explanation);
        yield deltaFrame(record.choice, { refusal: choice.refusal.explanation }, tier);
      }
      const summary = nativeAccumulator(record.choice).result().choices.find(choice => choice.index === record.choice)?.message.reasoning_text;
      if (typeof summary === 'string' && summary !== '') {
        yield deltaFrame(record.choice, { reasoning_details: [{ type: 'reasoning.summary', summary, format: 'unknown', index: 0 }] }, tier);
      }
      const nativeChoice = nativeAccumulator(record.choice).result().choices.find(choice => choice.index === record.choice);
      if (nativeChoice === undefined) throw new Error(`Missing Chat Completions choice ${record.choice} at choice_end`);
      const sourceTurnDigest = await computeOpenAIChatCompletionsTurnDigest(nativeChoice.message);
      const input = toOpenAIChatCompletionsInputAssistantTurn<ContentStates>(nativeChoice.message, outputState(record.choice));
      const data = await options.roundTrip.prepareSidecar(record.choice, sourceTurnDigest, input.turn, input.state, collectOpenAIChatCompletionsTextViews(input.turn));
      yield deltaFrame(record.choice, { reasoning_details: createOpenAIChatCompletionsSidecarCarrier(data) }, tier);
      yield chunk([{ index: record.choice, delta: {}, finish_reason: record.finish_reason }], tierFields(tier));
      continue;
    }

    if (record.type === 'finish') {
      if (state.usage !== undefined) yield chunk([], { usage: usageFromIR(state.usage), ...tierFields(tier) });
      yield doneFrame();
    }
  }
};
