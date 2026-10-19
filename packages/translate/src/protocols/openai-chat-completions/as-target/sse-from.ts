import { toOpenAIChatCompletionsInputAssistantTurn, type OpenAIChatCompletionsOutputAssistantState } from './assistant-turn.ts';
import { usageToIR } from './usage.ts';
import {
  createIRBuilder,
  type IRRecord,
  type IRItemHandle,
  type IRPartHandle,
  type IRWriteHandle,
  type IRRelativePath,
} from '../../../ir/stream.ts';
import { IRAbsent, type IRErrorPayload, type IRSourceCitation } from '../../../ir/types.ts';
import { appendField, createFieldState, type FieldStates, type FieldState, type ReferencePieceId } from '../../../round-trip/reference/reference-builder.ts';
import type { RoundTripReader } from '../../../round-trip/stream.ts';
import { TextCoordinateIndex } from '../../../shared/text-coordinate-index.ts';
import { unwrapCustomToolInput } from '../../openai-responses/common/custom-tool-wrap.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import {
  createOpenAIChatCompletionsEventAccumulator,
  type OpenAIChatCompletionsAnnotation,
  type OpenAIChatCompletionsAssistantDeltaEx,
  type OpenAIChatCompletionsLogprobs,
  type OpenAIChatCompletionsStreamEvent,
  type OpenAIChatCompletionsToolCallDeltaEx,
  type OpenAIChatCompletionsUsageEx,
} from '@floway-dev/protocols/openai-chat-completions';

type ChatToolFieldState = NonNullable<NonNullable<OpenAIChatCompletionsOutputAssistantState<FieldStates>['tool_calls']>[number]>;

interface ChatToolState {
  item?: IRItemHandle;
  id?: string;
  name: string;
  pendingInput: string;
  pendingReferencePieceIds: ReferencePieceId[];
  fieldState?: ChatToolFieldState;
  custom: boolean;
  wrapped: boolean;
  callIdAssigned: boolean;
  emittedName?: string;
}

type ChatDelta = OpenAIChatCompletionsAssistantDeltaEx;
type ChatToolCall = OpenAIChatCompletionsToolCallDeltaEx;
type NativeChatChoice = OpenAIChatCompletionsStreamEvent extends { choices: (infer Choice)[] } ? Choice : never;
type ChatChoiceEvent = Omit<NativeChatChoice, 'delta'> & {
  // Azure sends choices without a delta, and malformed upstreams send a non-object; both are checked at runtime.
  delta?: unknown;
};
type ChatChunk = Omit<OpenAIChatCompletionsStreamEvent, keyof { choices: unknown }> & {
  choices: ChatChoiceEvent[];
  error?: IRErrorPayload;
};

const isDelta = (value: unknown): value is ChatDelta => value !== null && typeof value === 'object' && !Array.isArray(value);

type ChatReasoningField = 'reasoning' | 'reasoning_text' | 'reasoning_content';

const chatReasoningField = (delta: ChatDelta): ChatReasoningField | undefined =>
  typeof delta.reasoning === 'string' ? 'reasoning'
    : typeof delta.reasoning_text === 'string' ? 'reasoning_text'
      : typeof delta.reasoning_content === 'string' ? 'reasoning_content' : undefined;

// Tool calls and the legacy `function_call` delta share one shape check; the latter carries name and arguments directly.
interface ToolFragment { name?: string; arguments?: string; input?: string }
interface ToolCallFields extends ToolFragment {
  id?: string;
  custom?: ToolFragment;
  function?: ToolFragment;
}

const hasToolCallContent = (call: ToolCallFields): boolean => {
  const fn = call.custom ?? call.function ?? call;
  return typeof call.id === 'string' && call.id !== ''
    || typeof fn?.name === 'string' && fn.name !== ''
    || typeof fn?.arguments === 'string' && fn.arguments !== ''
    || typeof fn?.input === 'string' && fn.input !== '';
};

const hasDeltaContent = (delta: ChatDelta): boolean => {
  const calls = delta.tool_calls;
  const reasoningField = chatReasoningField(delta);
  return reasoningField !== undefined && delta[reasoningField] !== ''
    || typeof delta.content === 'string' && delta.content !== ''
    || typeof delta.refusal === 'string' && delta.refusal !== ''
    || delta.audio != null
    || Array.isArray(delta.annotations) && delta.annotations.length > 0
    || Array.isArray(calls) && calls.some(hasToolCallContent)
    || delta.function_call !== undefined && hasToolCallContent(delta.function_call);
};

const hasLogprobContent = (entry: ChatChoiceEvent): boolean =>
  (entry.logprobs?.content?.length ?? 0) > 0 || (entry.logprobs?.refusal?.length ?? 0) > 0;

interface ChatTextSegment {
  readonly item: IRItemHandle;
  readonly part: IRPartHandle;
  readonly start: number;
  end: number;
}

interface ChatChoiceState {
  // Concatenated text of the message parts this choice has emitted, in order.
  // Maintained incrementally so a citation delta never re-walks finished parts.
  readonly textSegments: ChatTextSegment[];
  textContent: string;
  readonly annotatedParts: Set<IRPartHandle>;
  coordinateIndex?: TextCoordinateIndex;
  reasoningField?: ChatReasoningField;
  message?: IRItemHandle;
  text?: IRPartHandle;
  refusal?: IRPartHandle;
  audio?: IRPartHandle;
  reasoning?: IRItemHandle;
  readonly items: IRItemHandle[];
  readonly tools: Map<number, ChatToolState>;
  currentTool?: ChatToolState;
  readonly logprobParts: Map<string, { item: IRItemHandle; part: IRPartHandle }>;
  readonly logprobGroups: Map<IRPartHandle, { index: number; length: number }>;
  readonly fieldState: OpenAIChatCompletionsOutputAssistantState<FieldStates>;
  ended: boolean;
  incomplete: boolean;
}

export const irFromOpenAIChatCompletions = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  options: { customToolNames?: ReadonlySet<string>; maxChoices?: number; roundTrip: RoundTripReader<'openaiChatCompletions'> },
): AsyncGenerator<IRRecord> {
  const ir = createIRBuilder(options.maxChoices ?? 1);
  const choices = new Map<number, ChatChoiceState>();
  const nativeAccumulators = new Map<number, ReturnType<typeof createOpenAIChatCompletionsEventAccumulator>>();
  const nativeAccumulator = (choice: number): ReturnType<typeof createOpenAIChatCompletionsEventAccumulator> => {
    let accumulator = nativeAccumulators.get(choice);
    if (accumulator === undefined) {
      accumulator = createOpenAIChatCompletionsEventAccumulator();
      nativeAccumulators.set(choice, accumulator);
    }
    return accumulator;
  };
  let started = false;
  let hasModel = false;

  const choiceState = (index: number): ChatChoiceState => {
    let choice = choices.get(index);
    if (choice === undefined) {
      choice = {
        items: [],
        tools: new Map(),
        logprobParts: new Map(),
        logprobGroups: new Map(),
        textSegments: [],
        textContent: '',
        annotatedParts: new Set(),
        fieldState: {},
        ended: false,
        incomplete: false,
      };
      choices.set(index, choice);
    }
    return choice;
  };

  const appendFieldAtom = (
    handle: IRWriteHandle,
    field: IRRelativePath,
    text: string,
    state: FieldState<'text'>,
  ): void => {
    const partId = appendField(options.roundTrip.builder, state, text);
    handle.append(field, text, [partId]);
  };
  const createItem = (index: number, choice: ChatChoiceState, value: unknown): IRItemHandle => {
    const item = ir.item(index, value);
    choice.items.push(item);
    return item;
  };

  const start = (chunk: ChatChunk): void => {
    if (started) return;
    ir.event({
      type: 'start',
      ...(typeof chunk.id === 'string' && chunk.id !== '' ? { id: chunk.id } : {}),
      ...(typeof chunk.created === 'number' ? { created: chunk.created } : {}),
    });
    started = true;
  };

  const startForContent = (chunk: ChatChunk): void => {
    if (started) return;
    if (!hasModel) throw new TypeError('ChatCompletions content arrived before a non-empty model');
    start(chunk);
  };

  const assignUsage = (usage: OpenAIChatCompletionsUsageEx): void => {
    const converted = usageToIR(usage);
    if (!started && !hasModel) throw new TypeError('ChatCompletions usage arrived before a non-empty model');
    ir.usage(converted);
  };

  // Append text to the message part that currently owns the text channel, keeping the
  // choice's concatenated view and (once created) its coordinate index in step.
  const appendText = (index: number, choice: ChatChoiceState, text: string, field: FieldState<'text'>): void => {
    const part = messagePart(index, choice, 'text');
    appendFieldAtom(part, 'text', text, field);
    let segment = choice.textSegments.at(-1);
    if (segment?.part !== part) {
      segment = { item: choice.message!, part, start: segment?.end ?? 0, end: segment?.end ?? 0 };
      choice.textSegments.push(segment);
    }
    segment.end += text.length;
    choice.textContent += text;
    choice.coordinateIndex?.append(text);
  };

  const applyAnnotations = (choiceIndex: number, annotations: readonly OpenAIChatCompletionsAnnotation[]): void => {
    const state = choices.get(choiceIndex)!;
    const contentLength = state.textSegments.at(-1)?.end ?? 0;
    // The index is created on the first citation, so it must adopt the text that
    // already streamed. Earlier segments are only used to build that prefix.
    state.coordinateIndex ??= TextCoordinateIndex.codePointsToUTF16(state.textContent);
    state.coordinateIndex.assertUTF16Length(contentLength);
    const availableCodePoints = state.coordinateIndex.codePointLength;
    const citations = annotations.map(annotation => {
      const native = annotation.url_citation;
      if (!Number.isInteger(native.start_index) || !Number.isInteger(native.end_index) || native.start_index < 0 || native.end_index < native.start_index) {
        throw new RangeError('Invalid code-point range');
      }
      const start = Math.min(native.start_index, availableCodePoints);
      const end = Math.min(native.end_index, availableCodePoints);
      return { annotation, range: state.coordinateIndex!.codePointRangeToIR(start, end), exceedsAvailableText: native.end_index > availableCodePoints };
    });
    // Only the message that is still open can receive citations; earlier parts already ended.
    const openSegments = state.message?.isOpen === true ? state.textSegments.filter(segment => segment.item === state.message) : [];
    for (const segment of openSegments) {
      const converted: IRSourceCitation[] = citations.flatMap(({ annotation, range }) => {
        const start = Math.max(range.start, segment.start);
        const end = Math.min(range.end_exclusive, segment.end);
        if (start >= end) return [];
        return [{
          type: 'source_citation',
          source_kind: 'url',
          source: annotation.url_citation.url,
          source_label: annotation.url_citation.title,
          output_text_range: { start: start - segment.start, end_exclusive: end - segment.start },
        }];
      });
      if (converted.length > 0 || state.annotatedParts.has(segment.part)) {
        segment.part.assign('annotations', converted);
        state.annotatedParts.add(segment.part);
      }
    }
    for (const { annotation, range, exceedsAvailableText } of citations) {
      const retained = openSegments.reduce(
        (length, segment) => length + Math.max(0, Math.min(range.end_exclusive, segment.end) - Math.max(range.start, segment.start)),
        0,
      );
      if (retained === range.end_exclusive - range.start && !exceedsAvailableText) continue;
      const message = retained === 0 ? 'Dropping ChatCompletions citation outside open text' : 'Clamping ChatCompletions citation to open text';
      console.warn(message, { choice: choiceIndex, citation: annotation });
    }
  };

  const closeMessage = (choice: ChatChoiceState, status: 'completed' | 'incomplete' = 'completed'): void => {
    if (choice.message === undefined) return;
    choice.message.end(status);
    choice.message = choice.text = choice.refusal = choice.audio = undefined;
  };

  const closeReasoning = (choice: ChatChoiceState): void => {
    if (choice.reasoning === undefined) return;
    choice.reasoning.end('completed');
    choice.reasoning = undefined;
  };

  const closeTool = (tool: ChatToolState, status: 'completed' | 'incomplete' = 'completed'): void => {
    if (tool.item === undefined) throw new TypeError('Completed tool calls require a name');
    if (!tool.item.isOpen) return;
    if (tool.wrapped) {
      const input = unwrapCustomToolInput(tool.pendingInput);
      if (input !== '') tool.item.append('input', input);
      tool.pendingReferencePieceIds = [];
    }
    tool.item.end(status);
  };

  const finish = (): readonly IRRecord[] => {
    if (!started) throw new Error('ChatCompletions stream ended without a response');
    for (const [index, choice] of choices) if (!choice.ended) throw new Error(`ChatCompletions choice ${index} ended without finish_reason`);
    ir.event({ type: 'finish', status: [...choices.values()].some(choice => choice.incomplete) ? 'incomplete' : 'completed' });
    return ir.drain();
  };

  // The open part of this kind in the choice's message, created on first use.
  const messagePart = (index: number, choice: ChatChoiceState, kind: 'text' | 'refusal' | 'audio'): IRPartHandle => {
    closeReasoning(choice);
    choice.message ??= createItem(index, choice, { type: 'message', content: [] });
    choice[kind] ??= choice.message.part(kind === 'audio' ? { type: 'audio', audio: {} } : { type: kind, [kind]: '' });
    const part = choice[kind];
    if (kind !== 'audio') choice.logprobParts.set(kind === 'text' ? 'content' : 'refusal', { item: choice.message, part });
    return part;
  };

  const readReasoning = (index: number, choice: ChatChoiceState, delta: ChatDelta): void => {
    const field = choice.reasoningField;
    if (field === undefined) return;
    const text = delta[field];
    if (typeof text === 'string' && text !== '') {
      closeMessage(choice);
      const reasoning = choice.reasoning ??= createItem(index, choice, { type: 'reasoning', summary: [''] });
      reasoning.ensure('summary', ['']);
      const fieldState = choice.fieldState[field] ??= createFieldState('text');
      appendFieldAtom(reasoning, ['summary', 0], text, fieldState);
    }
  };

  const readMessage = (index: number, choice: ChatChoiceState, delta: ChatDelta): void => {
    if (typeof delta.content === 'string' && delta.content !== '') {
      const field = choice.fieldState.content ??= createFieldState('text');
      appendText(index, choice, delta.content, field);
    }
    if (typeof delta.refusal === 'string' && delta.refusal !== '') {
      const field = choice.fieldState.refusal ??= createFieldState('text');
      appendFieldAtom(messagePart(index, choice, 'refusal'), 'refusal', delta.refusal, field);
    }
    if (delta.audio != null) {
      const part = messagePart(index, choice, 'audio');
      for (const field of ['data', 'transcript'] as const) {
        if (delta.audio[field] === undefined) continue;
        part.ensure(['audio', field], '');
        if (delta.audio[field] !== '') part.append(['audio', field], delta.audio[field]);
      }
    }
    if (delta.annotations != null) applyAnnotations(index, delta.annotations);
  };

  const readLogprobs = (index: number, choice: ChatChoiceState, logprobs: OpenAIChatCompletionsLogprobs): void => {
    const choiceHandle = ir.choice(index);
    choiceHandle.ensure('logprobs', []);
    for (const kind of ['content', 'refusal'] as const) {
      const tokens = logprobs[kind];
      if (tokens == null || tokens.length === 0) continue;
      const owner = choice.logprobParts.get(kind);
      if (owner === undefined) throw new TypeError('ChatCompletions logprobs require a matching text part');
      let group = choice.logprobGroups.get(owner.part);
      if (group === undefined) {
        group = { index: choice.logprobGroups.size, length: 0 };
        choiceHandle.initialize(['logprobs', group.index], {
          scope: 'text_part',
          item_index: owner.item.index,
          content_index: owner.part.index,
          tokens: [],
        });
        choice.logprobGroups.set(owner.part, group);
      }
      for (const token of tokens) choiceHandle.assign(['logprobs', group.index, 'tokens', group.length++], token);
    }
  };

  const readToolCall = (index: number, choice: ChatChoiceState, call: ChatToolCall): void => {
    let tool = choice.tools.get(call.index);
    if (tool?.item !== undefined && !tool.item.isOpen) {
      console.warn('Ignoring ChatCompletions update for a closed tool call', { choice: index, tool: call.index });
      return;
    }
    if (tool === undefined) {
      // ChatCompletions has no per-call completion frame. Infer function completion
      // from the next tool index; custom input remains open until choice completion.
      // A syntactically closed JSON prefix is not an end marker: completed calls have
      // contained malformed concatenated objects.
      // https://github.com/openai/openai-node/blob/2b12eabd29733c8de495bb183b41632e091b4994/src/lib/ChatCompletionStream.ts#L1457-L1475
      // https://github.com/openai/openai-node/blob/2b12eabd29733c8de495bb183b41632e091b4994/src/lib/ChatCompletionStream.ts#L1564-L1575
      // https://github.com/openai/openai-node/issues/265
      if (choice.currentTool !== undefined && !choice.currentTool.custom) closeTool(choice.currentTool);
      closeMessage(choice);
      closeReasoning(choice);
      tool = {
        name: '',
        pendingInput: '',
        pendingReferencePieceIds: [],
        custom: call.type === 'custom' || call.custom !== undefined,
        wrapped: false,
        callIdAssigned: false,
      };
      choice.tools.set(call.index, tool);
      if (call.index >= 0) (choice.fieldState.tool_calls ??= [])[call.index] = undefined;
      choice.currentTool = tool;
    }
    const fn: ToolFragment | undefined = call.custom ?? call.function;
    if (call.id !== undefined) tool.id = call.id;
    if (fn?.name !== undefined) tool.name = fn.name;
    const fragment = fn?.arguments ?? fn?.input;
    let fragmentReferencePieceId: ReferencePieceId | undefined;
    if (typeof fragment === 'string' && fragment !== '') {
      let field: FieldStates['text'];
      if (call.index === -1) {
        const state = choice.fieldState.function_call ??= {};
        field = state.arguments ??= createFieldState('text');
      } else {
        const state = tool.fieldState;
        if (call.custom !== undefined) {
          const existing = state !== undefined && 'custom' in state ? state.custom?.input : undefined;
          field = existing ?? createFieldState('text');
          if (existing === undefined) tool.fieldState = { custom: { input: field } };
        } else {
          const existing = state !== undefined && 'function' in state ? state.function?.arguments : undefined;
          field = existing ?? createFieldState('text');
          if (existing === undefined) tool.fieldState = { function: { arguments: field } };
        }
        (choice.fieldState.tool_calls ??= [])[call.index] = tool.fieldState;
      }
      fragmentReferencePieceId = appendField(options.roundTrip.builder, field, fragment);
    }
    tool.wrapped = !tool.custom && options.customToolNames?.has(tool.name) === true;
    if (tool.item === undefined && fragment !== undefined) {
      tool.pendingInput += fragment;
      if (fragmentReferencePieceId !== undefined) tool.pendingReferencePieceIds.push(fragmentReferencePieceId);
    }

    if (tool.item === undefined && tool.name !== '') {
      // Waiting here delays no supported target: Messages and Responses need the name when
      // the structure opens, while GenerateContent emits only complete calls. Planned
      // Interactions support has the same step.start requirement:
      // https://ai.google.dev/gemini-api/docs/streaming
      // The official ChatCompletions SDK tolerates a late name:
      // https://github.com/openai/openai-node/blob/7423ac3e9351c46300cd094479cded5551a72eb4/src/lib/ChatCompletionStream.ts#L2059-L2107
      // Clients such as the Vercel AI SDK reject a first tool delta without one:
      // https://github.com/vercel/ai/blob/ba05943b69ad070558bb5bc912da99ec66d7d263/packages/provider-utils/src/streaming-tool-call-tracker.ts#L356-L395
      const custom = tool.custom || tool.wrapped;
      const callId = call.index === -1 ? IRAbsent : tool.id;
      tool.item = createItem(index, choice, custom
        ? { type: 'custom_tool_call', ...(callId === undefined ? {} : { call_id: callId }), name: tool.name, input: '' }
        : { type: 'function_call', ...(callId === undefined ? {} : { call_id: callId }), name: tool.name, arguments: '' });
      tool.callIdAssigned = callId !== undefined;
      tool.emittedName = tool.name;
      if (!tool.wrapped && tool.pendingInput !== '') {
        const referencePieceIds = tool.pendingReferencePieceIds;
        tool.item.append(custom ? 'input' : 'arguments', tool.pendingInput, referencePieceIds.length > 0 ? referencePieceIds : undefined);
        tool.pendingInput = '';
        tool.pendingReferencePieceIds = [];
      }
    } else if (tool.item !== undefined) {
      if (tool.id !== undefined && !tool.callIdAssigned) {
        tool.item.assign('call_id', tool.id);
        tool.callIdAssigned = true;
      }
      if (tool.name !== tool.emittedName) {
        tool.item.assign('name', tool.name);
        tool.emittedName = tool.name;
      }
      if (fragment !== undefined && fragment !== '' && !tool.wrapped) tool.item.append(tool.custom ? 'input' : 'arguments', fragment, fragmentReferencePieceId === undefined ? undefined : [fragmentReferencePieceId]);
      if (fragment !== undefined && tool.wrapped) tool.pendingInput += fragment;
    }
  };

  const endChoice = (index: number, choice: ChatChoiceState, finishReason: string): void => {
    const status = finishReason === 'length' ? 'incomplete' : 'completed';
    closeMessage(choice, status);
    for (const tool of choice.tools.values()) closeTool(tool, status);
    for (const item of choice.items) item.end(status);
    const nativeChoice = nativeAccumulator(index).result().choices.find(resultChoice => resultChoice.index === index);
    if (nativeChoice === undefined) throw new Error(`Missing Chat Completions choice ${index} at choice_end`);
    if (choice.fieldState.tool_calls !== undefined) choice.fieldState.tool_calls = [...choice.tools]
      .filter(([wireIndex]) => wireIndex >= 0)
      .toSorted(([left], [right]) => left - right)
      .map(([, tool]) => tool.fieldState);
    const input = toOpenAIChatCompletionsInputAssistantTurn<FieldStates>(nativeChoice.message, choice.fieldState);
    options.roundTrip.onAssistantTurn(index, input.turn, input.state);
    ir.choice(index).end(finishReason === 'function_call'
      ? 'tool_calls'
      : finishReason as 'stop' | 'length' | 'tool_calls' | 'content_filter');
    choice.ended = true;
    choice.incomplete = finishReason === 'length';
  };

  const readChoice = (chunk: ChatChunk, entry: ChatChoiceEvent): void => {
    const index = entry.index as number;
    const nativeDelta = entry.delta;
    const deltaIsObject = isDelta(nativeDelta);
    const delta: ChatDelta = deltaIsObject ? nativeDelta : {};
    const hasContent = hasDeltaContent(delta) || hasLogprobContent(entry);
    if (choices.get(index)?.ended) {
      if (hasContent) console.warn('Ignoring ChatCompletions content for a closed choice', { choice: index });
      return;
    }
    if (nativeDelta != null && !deltaIsObject) throw new TypeError('ChatCompletions choice delta must be an object');
    nativeAccumulator(index).accept({ ...chunk, choices: [{ ...entry, delta }] });

    const choice = choiceState(index);
    // Scalar reasoning fields are aliases; keep the first observed field for the choice.
    // https://github.com/OpenRouterTeam/docs/blob/8593a3e9d21db4ca3d4a2d92cc80ab989430e38e/guides/best-practices/reasoning-tokens.mdx#L495-L499
    choice.reasoningField ??= chatReasoningField(delta);
    if (!hasContent && entry.finish_reason == null) return;

    startForContent(chunk);
    ir.choice(index);
    readReasoning(index, choice, delta);
    readMessage(index, choice, delta);
    if (entry.logprobs != null) readLogprobs(index, choice, entry.logprobs);
    const calls = [
      ...(delta.tool_calls ?? []),
      ...(delta.function_call === undefined ? [] : [{ index: -1, type: 'function' as const, function: delta.function_call }]),
    ];
    for (const call of calls) readToolCall(index, choice, call);
    if (entry.finish_reason != null) endChoice(index, choice, entry.finish_reason);
  };

  for await (const frame of frames) {
    if (frame.type === 'done') { yield* finish(); return; }
    const chunk: ChatChunk = frame.event;
    if (chunk.error !== undefined) { ir.event({ type: 'error', error: chunk.error }); yield* ir.drain(); return; }
    const model = typeof chunk.model === 'string' && chunk.model !== '' ? chunk.model : undefined;
    if (model !== undefined) {
      ir.assign(['model'], model);
      hasModel = true;
    }
    if (typeof chunk.service_tier === 'string') ir.assign(['service_tier'], chunk.service_tier);
    if (chunk.usage != null) assignUsage(chunk.usage);
    if (!started && model !== undefined) start(chunk);

    // OpenAI specifies stable id/created, a fixed object discriminator, and a delta on each choice.
    // Azure sends blank-identity prompt/filter frames and choices without delta:
    // https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/content-streaming
    // https://github.com/dotnet/extensions/issues/7812
    // https://github.com/dotnet/extensions/issues/7790
    // Copilot omits object, varies created, and begins with an empty-id prompt frame; redacted probe evidence:
    // https://github.com/Menci/Floway/pull/594#issuecomment-6129531836
    for (const entry of chunk.choices) readChoice(chunk, entry);
    yield* ir.drain();
  }
  yield* finish();
};
