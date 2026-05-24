import { toResponseReasoningItem } from '../shared/chat-and-responses/reasoning.ts';
import { unwrapCustomToolInput } from '../shared/responses-via/custom-tool-wrap.ts';
import * as responses from '../shared/responses-via/responses-event-builder.ts';
import type { ChatCompletionChunk, ChatCompletionResponse, ChatReasoningItem } from '@floway-dev/protocols/chat-completions';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponseOutputItem, ResponseOutputReasoning, ResponsesResult, ResponsesStreamEvent, ResponseStreamEvent } from '@floway-dev/protocols/responses';

const mapChatCompletionsUsageToResponsesUsage = (usage: ChatCompletionResponse['usage'] | undefined): ResponsesResult['usage'] | undefined =>
  usage
    ? {
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        ...(usage.prompt_tokens_details?.cached_tokens !== undefined
          ? {
              input_tokens_details: {
                cached_tokens: usage.prompt_tokens_details.cached_tokens,
              },
            }
          : {}),
      }
    : undefined;

const UPSTREAM_CHAT_COMPLETIONS_MISSING_DONE_MESSAGE = 'Upstream Chat Completions stream ended without a DONE sentinel.';

const upstreamChatCompletionEventsUntilDone = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>): AsyncGenerator<ChatCompletionChunk> {
  for await (const frame of frames) {
    if (frame.type === 'done') return;
    yield frame.event;
  }

  throw new Error(UPSTREAM_CHAT_COMPLETIONS_MISSING_DONE_MESSAGE);
};

interface PendingScalarReasoningItem {
  text: string;
}

interface PendingTextItem {
  outputIndex: number;
  itemId: string;
  text: string;
}

interface FunctionCallStreamItem {
  outputIndex: number;
  itemId: string;
  kind: 'function' | 'custom';
}

interface PendingFunctionCallItem {
  streamItem?: FunctionCallStreamItem;
  callId?: string;
  name?: string;
  arguments: string;
}

type StartedFunctionCallItem = PendingFunctionCallItem & {
  streamItem: FunctionCallStreamItem;
  callId: string;
  name: string;
};

type ChatStreamDelta = ChatCompletionChunk['choices'][0]['delta'];
type ChatStreamToolCalls = NonNullable<ChatStreamDelta['tool_calls']>;
type ChatFinishReason = NonNullable<ChatCompletionChunk['choices'][0]['finish_reason']>;

type DeferredAfterReasoning = { type: 'content'; content: string } | { type: 'tool_calls'; toolCalls: ChatStreamToolCalls };

interface ChatCompletionsToResponsesStreamState {
  responseCreated: boolean;
  outputIndex: number;
  sequenceNumber: number;
  responseId: string;
  model: string;
  outputText: string;
  completedItems: (ResponseOutputItem | undefined)[];
  pendingScalarReasoning?: PendingScalarReasoningItem;
  openText?: PendingTextItem;
  openFunctionCalls: Map<number, PendingFunctionCallItem>;
  deferredAfterReasoning: DeferredAfterReasoning[];
  reasoningItemsSeen: boolean;
  usage?: ResponsesResult['usage'];
  pendingFinishReason?: ChatFinishReason;
  completed: boolean;
  customToolNames: ReadonlySet<string>;
}

export const createChatCompletionsToResponsesStreamState = (customToolNames: ReadonlySet<string> = new Set()): ChatCompletionsToResponsesStreamState => ({
  responseCreated: false,
  outputIndex: 0,
  sequenceNumber: 0,
  responseId: '',
  model: '',
  outputText: '',
  completedItems: [],
  openFunctionCalls: new Map(),
  deferredAfterReasoning: [],
  reasoningItemsSeen: false,
  completed: false,
  customToolNames,
});

const buildResult = (state: ChatCompletionsToResponsesStreamState, status: ResponsesResult['status']): ResponsesResult =>
  responses.result({
    id: state.responseId,
    model: state.model,
    output: state.completedItems.filter((item): item is ResponseOutputItem => item !== undefined),
    outputText: state.outputText,
    status,
    ...(state.usage !== undefined ? { usage: state.usage } : {}),
  });

const ensureResponseCreated = (chunk: ChatCompletionChunk, state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  state.responseId = chunk.id;
  state.model = chunk.model;

  if (chunk.usage) {
    state.usage = mapChatCompletionsUsageToResponsesUsage(chunk.usage);
  }

  if (state.responseCreated) return [];

  state.responseCreated = true;
  const response = buildResult(state, 'in_progress');

  return responses.started(state, response);
};

const emitCompletedReasoningItem = (item: ResponseOutputReasoning, outputIndex: number, state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  state.completedItems[outputIndex] = item;

  return responses.completedReasoning(state, outputIndex, item);
};

const commitPendingScalarReasoning = (state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  if (!state.pendingScalarReasoning) return [];

  const reasoning = state.pendingScalarReasoning;
  state.pendingScalarReasoning = undefined;
  const outputIndex = state.outputIndex++;
  const item = responses.reasoningItem(`rs_${outputIndex}`, reasoning.text);

  return emitCompletedReasoningItem(item, outputIndex, state);
};

const closeText = (state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  if (!state.openText) return [];

  const textItem = state.openText;
  state.openText = undefined;

  const item = responses.messageItem(textItem.text);

  state.completedItems[textItem.outputIndex] = item;

  return responses.textDone(state, textItem.outputIndex, textItem.itemId, textItem.text, item);
};

const closeFunctionCalls = (state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  const events: ResponseStreamEvent[] = [];

  for (const functionCall of [...state.openFunctionCalls.values()]
    .filter((item): item is StartedFunctionCallItem => item.streamItem !== undefined && Boolean(item.callId) && Boolean(item.name))
    .sort((a, b) => a.streamItem.outputIndex - b.streamItem.outputIndex)) {
    const { outputIndex, itemId, kind } = functionCall.streamItem;

    if (kind === 'custom') {
      const input = unwrapCustomToolInput(functionCall.arguments);
      const item = responses.customToolCallItem(functionCall.callId, functionCall.name, input);

      state.completedItems[outputIndex] = item;
      events.push(...responses.customToolCallDone(state, outputIndex, itemId, input, item));
      continue;
    }

    const item = responses.functionCallItem(functionCall.callId, functionCall.name, functionCall.arguments, 'completed');

    state.completedItems[outputIndex] = item;
    events.push(...responses.functionCallDone(state, outputIndex, itemId, functionCall.arguments, item));
  }

  state.openFunctionCalls.clear();
  return events;
};

const openScalarReasoning = (state: ChatCompletionsToResponsesStreamState): PendingScalarReasoningItem =>
  (state.pendingScalarReasoning ??= {
    text: '',
  });

const hasReadableSummary = (item: ChatReasoningItem): boolean => item.summary?.some(part => part.text) === true;

const openText = (state: ChatCompletionsToResponsesStreamState): { item: PendingTextItem; events: ResponseStreamEvent[] } => {
  if (state.openText) return { item: state.openText, events: [] };

  const outputIndex = state.outputIndex++;
  const itemId = `msg_${outputIndex}`;
  const item = { outputIndex, itemId, text: '' };
  state.openText = item;

  return {
    item,
    events: responses.textStart(state, outputIndex, itemId),
  };
};

const startFunctionCall = (current: PendingFunctionCallItem, state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  if (current.streamItem || !current.callId || !current.name) {
    return [];
  }

  const isCustom = state.customToolNames.has(current.name);
  const outputIndex = state.outputIndex++;
  const streamItem: FunctionCallStreamItem = {
    outputIndex,
    itemId: isCustom ? `ctc_${outputIndex}` : `fc_${outputIndex}`,
    kind: isCustom ? 'custom' : 'function',
  };
  current.streamItem = streamItem;

  if (isCustom) {
    // Wrapped custom tool calls buffer arguments fully; we cannot emit input
    // deltas until we can parse the JSON wrap and extract the freeform value.
    return responses.itemAdded(state, outputIndex, responses.customToolCallItem(current.callId, current.name, ''));
  }

  const events = responses.itemAdded(state, outputIndex, responses.functionCallItem(current.callId, current.name, '', 'in_progress'));

  if (current.arguments) {
    events.push(...responses.argumentsDelta(state, outputIndex, streamItem.itemId, current.arguments));
  }

  return events;
};

const emitContentDelta = (content: string, state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  const { item, events } = openText(state);
  item.text += content;
  state.outputText += content;
  events.push(...responses.textDelta(state, item.outputIndex, item.itemId, content));

  return events;
};

const emitToolCallsDelta = (toolCalls: ChatStreamToolCalls, state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  const events: ResponseStreamEvent[] = [];
  events.push(...closeText(state));

  for (const toolCall of toolCalls) {
    const current = state.openFunctionCalls.get(toolCall.index) ?? {
      arguments: '',
    };

    if (toolCall.id) current.callId = toolCall.id;
    // OpenAI's documented Chat Completions stream contract delivers each tool
    // call's `function.name` in a single delta — we pin `kind` once `name` is
    // first present (in startFunctionCall) and never re-evaluate. A custom
    // upstream that fragmented `name` across deltas would race the kind
    // decision; we don't defend against that here because emitting
    // `response.output_item.added` as a function tool first and then trying
    // to retract it for a custom tool isn't a wire-supported transition.
    // Reference: https://github.com/openai/openai-python/blob/main/src/openai/lib/streaming/chat/_completions.py
    if (toolCall.function?.name) current.name = toolCall.function.name;
    state.openFunctionCalls.set(toolCall.index, current);
    events.push(...startFunctionCall(current, state));

    if (!toolCall.function?.arguments) continue;

    current.arguments += toolCall.function.arguments;

    // Wrapped custom tool calls have no live delta on the Responses side; the
    // freeform input is extracted at close time. Function tools keep streaming.
    if (current.streamItem?.kind === 'function') {
      events.push(...responses.argumentsDelta(state, current.streamItem.outputIndex, current.streamItem.itemId, toolCall.function.arguments));
    }
  }

  return events;
};

const commitReasoningAndReplayDeferredDeltas = (state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  const events: ResponseStreamEvent[] = [];
  events.push(...commitPendingScalarReasoning(state));

  const deferred = state.deferredAfterReasoning;
  state.deferredAfterReasoning = [];

  for (const item of deferred) {
    events.push(...(item.type === 'content' ? emitContentDelta(item.content, state) : emitToolCallsDelta(item.toolCalls, state)));
  }

  return events;
};

const finalize = (state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  if (state.completed || state.pendingFinishReason === undefined) return [];

  const events = [...commitReasoningAndReplayDeferredDeltas(state), ...closeText(state), ...closeFunctionCalls(state)];

  state.completed = true;
  const incomplete = state.pendingFinishReason === 'length';
  const status: ResponsesResult['status'] = incomplete ? 'incomplete' : 'completed';

  return [...events, ...responses.terminal(state, buildResult(state, status))];
};

export const translateChatCompletionsChunkToResponsesEvents = (chunk: ChatCompletionChunk, state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => {
  const events = ensureResponseCreated(chunk, state);

  if (chunk.choices.length === 0) {
    return [...events, ...finalize(state)];
  }

  for (const choice of chunk.choices) {
    const readableReasoningItems = choice.delta.reasoning_items?.filter(hasReadableSummary) ?? [];

    if (readableReasoningItems.length) {
      const hadPendingScalarReasoning = state.pendingScalarReasoning !== undefined;
      state.reasoningItemsSeen = true;

      if (hadPendingScalarReasoning) {
        // Chat stream composition can emit legacy scalar reasoning first and a
        // richer item-level `reasoning_items[]` carrier later. Responses SSE
        // items are not retractable, so scalar reasoning remains buffered until
        // either a carrier replaces it or finalization commits it.
        state.pendingScalarReasoning = undefined;
      } else {
        events.push(...commitReasoningAndReplayDeferredDeltas(state));
        events.push(...closeText(state));
      }

      for (const item of readableReasoningItems) {
        const outputIndex = state.outputIndex++;
        events.push(...emitCompletedReasoningItem(toResponseReasoningItem<ResponseOutputReasoning>(item, `rs_${outputIndex}`), outputIndex, state));
      }

      if (hadPendingScalarReasoning) {
        events.push(...commitReasoningAndReplayDeferredDeltas(state));
      }
    } else if (choice.delta.reasoning_text) {
      if (!state.reasoningItemsSeen) {
        if (!state.pendingScalarReasoning) events.push(...closeText(state));
        const reasoning = openScalarReasoning(state);

        if (choice.delta.reasoning_text) {
          reasoning.text += choice.delta.reasoning_text;
        }
      }
    }

    if (choice.delta.content) {
      if (state.pendingScalarReasoning) {
        state.deferredAfterReasoning.push({
          type: 'content',
          content: choice.delta.content,
        });
      } else {
        events.push(...emitContentDelta(choice.delta.content, state));
      }
    }

    if (choice.delta.tool_calls?.length) {
      if (state.pendingScalarReasoning) {
        state.deferredAfterReasoning.push({
          type: 'tool_calls',
          toolCalls: choice.delta.tool_calls,
        });
      } else {
        events.push(...emitToolCallsDelta(choice.delta.tool_calls, state));
      }
    }

    if (choice.finish_reason) {
      state.pendingFinishReason = choice.finish_reason;
    }
  }

  return events;
};

export const flushChatCompletionsToResponsesEvents = (state: ChatCompletionsToResponsesStreamState): ResponseStreamEvent[] => finalize(state);

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>,
  customToolNames: ReadonlySet<string> = new Set(),
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const state = createChatCompletionsToResponsesStreamState(customToolNames);

  for await (const chunk of upstreamChatCompletionEventsUntilDone(frames)) {
    for (const event of translateChatCompletionsChunkToResponsesEvents(chunk, state)) {
      yield eventFrame(event);
    }
  }

  for (const event of flushChatCompletionsToResponsesEvents(state)) {
    yield eventFrame(event);
  }
};
