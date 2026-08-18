import { hasReadableSummary, toOpenAIResponsesReasoningItem } from '../shared/openai-chat-completions-and-openai-responses/reasoning.ts';
import { unwrapCustomToolInput } from '../shared/openai-responses-via/custom-tool-wrap.ts';
import * as openaiResponses from '../shared/openai-responses-via/openai-responses-event-builder.ts';
import { eventFrame, splitInclusiveInputTokens, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsResult } from '@floway-dev/protocols/openai-chat-completions';
import { createRandomOpenAIResponsesItemId, type OpenAIResponsesOutputItem, type OpenAIResponsesOutputReasoning, type OpenAIResponsesResult, type OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

const mapOpenAIChatCompletionsUsageToOpenAIResponsesUsage = (usage: OpenAIChatCompletionsResult['usage'] | undefined): NonNullable<OpenAIResponsesResult['usage']> | undefined => {
  if (!usage) return undefined;
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  const cacheWriteTokens = usage.prompt_tokens_details?.cache_creation_input_tokens
    ?? usage.prompt_tokens_details?.cache_write_tokens;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
  // Validated, not consumed. OpenAI OpenAIResponses names the same three input buckets
  // OpenAI Chat Completions does, so the counts cross unchanged and there is nothing
  // to recompute — but this package is the one asserting that what it emits
  // satisfies the inclusive contract its own output type declares, rather than
  // relying on whoever happens to read the usage next.
  splitInclusiveInputTokens(usage.prompt_tokens, cachedTokens, cacheWriteTokens);
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    ...(cachedTokens !== undefined || cacheWriteTokens !== undefined
      ? {
          input_tokens_details: {
            cached_tokens: cachedTokens ?? 0,
            ...(cacheWriteTokens !== undefined ? { cache_write_tokens: cacheWriteTokens } : {}),
          },
        }
      : {}),
    // OpenAI Chat Completions' `reasoning_tokens` and OpenAI OpenAIResponses' `reasoning_tokens`
    // are the same quantity, so an upstream that reports one is translated
    // rather than dropped. OpenAI's schema makes the breakdown mandatory, but
    // a translator's output is interior — a zero synthesized here would be
    // indistinguishable from a zero an upstream measured — so absence stays
    // absence, exactly as for the input breakdown above.
    // https://github.com/openai/openai-python/blob/f16fbbd2bd25dc1ff150b5f78dbd15ff6bab6d91/src/openai/types/openaiResponses/response_usage.py#L21-L47
    ...(reasoningTokens === undefined ? {} : { output_tokens_details: { reasoning_tokens: reasoningTokens } }),
  };
};

const UPSTREAM_OPENAI_CHAT_COMPLETIONS_MISSING_DONE_MESSAGE = 'Upstream OpenAI Chat Completions stream ended without a DONE sentinel.';

const upstreamChatCompletionEventsUntilDone = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>): AsyncGenerator<OpenAIChatCompletionsStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') return;
    yield frame.event;
  }

  throw new Error(UPSTREAM_OPENAI_CHAT_COMPLETIONS_MISSING_DONE_MESSAGE);
};

interface PendingScalarReasoningItem {
  text: string;
}

interface PendingTextItem {
  outputIndex: number;
  itemId: string;
  text: string;
}

interface PendingRefusalItem {
  outputIndex: number;
  itemId: string;
  refusal: string;
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

type OpenAIChatCompletionsStreamDelta = OpenAIChatCompletionsStreamEvent['choices'][0]['delta'];
type OpenAIChatCompletionsStreamToolCalls = NonNullable<OpenAIChatCompletionsStreamDelta['tool_calls']>;
type OpenAIChatCompletionsFinishReason = NonNullable<OpenAIChatCompletionsStreamEvent['choices'][0]['finish_reason']>;

type DeferredAfterReasoning =
  | { type: 'content'; content: string }
  | { type: 'refusal'; refusal: string }
  | { type: 'tool_calls'; toolCalls: OpenAIChatCompletionsStreamToolCalls };

interface OpenAIChatCompletionsToOpenAIResponsesStreamState {
  responseCreated: boolean;
  outputIndex: number;
  sequenceNumber: number;
  responseId: string;
  model: string;
  outputText: string;
  completedItems: (OpenAIResponsesOutputItem | undefined)[];
  pendingScalarReasoning?: PendingScalarReasoningItem;
  openText?: PendingTextItem;
  openRefusal?: PendingRefusalItem;
  openFunctionCalls: Map<number, PendingFunctionCallItem>;
  deferredAfterReasoning: DeferredAfterReasoning[];
  reasoningItemsSeen: boolean;
  usage?: NonNullable<OpenAIResponsesResult['usage']>;
  serviceTier?: OpenAIResponsesResult['service_tier'];
  pendingFinishReason?: OpenAIChatCompletionsFinishReason;
  completed: boolean;
  customToolNames: ReadonlySet<string>;
}

export const createOpenAIChatCompletionsToOpenAIResponsesStreamState = (customToolNames: ReadonlySet<string> = new Set()): OpenAIChatCompletionsToOpenAIResponsesStreamState => ({
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

const buildResult = (state: OpenAIChatCompletionsToOpenAIResponsesStreamState, status: OpenAIResponsesResult['status']): OpenAIResponsesResult =>
  openaiResponses.result({
    id: state.responseId,
    model: state.model,
    output: state.completedItems.filter((item): item is OpenAIResponsesOutputItem => item !== undefined),
    outputText: state.outputText,
    status,
    // OpenAI Chat Completions surfaces "ran out of tokens" via
    // `finish_reason === 'length'`, which the caller has already mapped
    // to `status === 'incomplete'`. Other finish reasons that could map
    // to `incomplete` (`content_filter`) emit a separate envelope in
    // OpenAI Chat Completions and don't reach this builder.
    ...(status === 'incomplete' ? { incompleteDetails: { reason: 'max_output_tokens' as const } } : {}),
    ...(state.usage !== undefined ? { usage: state.usage } : {}),
    ...(state.serviceTier !== undefined ? { serviceTier: state.serviceTier } : {}),
  });

const ensureResponseCreated = (chunk: OpenAIChatCompletionsStreamEvent, state: OpenAIChatCompletionsToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  state.responseId = chunk.id;
  state.model = chunk.model;
  if (chunk.service_tier !== undefined) state.serviceTier = chunk.service_tier;

  if (chunk.usage) {
    state.usage = mapOpenAIChatCompletionsUsageToOpenAIResponsesUsage(chunk.usage);
  }

  if (state.responseCreated) return [];

  state.responseCreated = true;
  const response = buildResult(state, 'in_progress');

  return openaiResponses.started(state, response);
};

const emitCompletedReasoningItem = (item: OpenAIResponsesOutputReasoning, outputIndex: number, state: OpenAIChatCompletionsToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  state.completedItems[outputIndex] = item;

  return openaiResponses.completedReasoning(state, outputIndex, item);
};

const commitPendingScalarReasoning = (state: OpenAIChatCompletionsToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  if (!state.pendingScalarReasoning) return [];

  const reasoning = state.pendingScalarReasoning;
  state.pendingScalarReasoning = undefined;
  const outputIndex = state.outputIndex++;
  const item = openaiResponses.reasoningItem(createRandomOpenAIResponsesItemId('reasoning'), reasoning.text);

  return emitCompletedReasoningItem(item, outputIndex, state);
};

const closeText = (state: OpenAIChatCompletionsToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  if (!state.openText) return [];

  const textItem = state.openText;
  state.openText = undefined;

  // OpenAI Chat Completions has no citation channel, so a translated text part
  // never carries annotations.
  const part = openaiResponses.textPart(textItem.text, []);
  const item = openaiResponses.messageItem(textItem.itemId, 'completed', part);

  state.completedItems[textItem.outputIndex] = item;

  return openaiResponses.textDone(state, textItem.outputIndex, textItem.itemId, part, item);
};

const closeRefusal = (state: OpenAIChatCompletionsToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  if (!state.openRefusal) return [];

  const refusalItem = state.openRefusal;
  state.openRefusal = undefined;

  const part = openaiResponses.refusalPart(refusalItem.refusal);
  const item = openaiResponses.messageItem(refusalItem.itemId, 'completed', part);
  state.completedItems[refusalItem.outputIndex] = item;

  return openaiResponses.refusalDone(state, refusalItem.outputIndex, refusalItem.itemId, part, item);
};

const closeFunctionCalls = (state: OpenAIChatCompletionsToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  const events: OpenAIResponsesStreamEvent[] = [];

  for (const functionCall of [...state.openFunctionCalls.values()]
    .filter((item): item is StartedFunctionCallItem => item.streamItem !== undefined && Boolean(item.callId) && Boolean(item.name))
    .sort((a, b) => a.streamItem.outputIndex - b.streamItem.outputIndex)) {
    const { outputIndex, itemId, kind } = functionCall.streamItem;

    if (kind === 'custom') {
      const input = unwrapCustomToolInput(functionCall.arguments);
      const item = openaiResponses.customToolCallItem(itemId, functionCall.callId, functionCall.name, input);

      state.completedItems[outputIndex] = item;
      events.push(...openaiResponses.customToolCallDone(state, outputIndex, itemId, input, item));
      continue;
    }

    const item = openaiResponses.functionCallItem(itemId, functionCall.callId, functionCall.name, functionCall.arguments, 'completed');

    state.completedItems[outputIndex] = item;
    events.push(...openaiResponses.functionCallDone(state, outputIndex, itemId, functionCall.arguments, item));
  }

  state.openFunctionCalls.clear();
  return events;
};

const openScalarReasoning = (state: OpenAIChatCompletionsToOpenAIResponsesStreamState): PendingScalarReasoningItem =>
  (state.pendingScalarReasoning ??= {
    text: '',
  });

const openText = (state: OpenAIChatCompletionsToOpenAIResponsesStreamState): { item: PendingTextItem; events: OpenAIResponsesStreamEvent[] } => {
  if (state.openText) return { item: state.openText, events: [] };

  const outputIndex = state.outputIndex++;
  const itemId = createRandomOpenAIResponsesItemId('message');
  const item = { outputIndex, itemId, text: '' };
  state.openText = item;

  return {
    item,
    events: openaiResponses.textStart(state, outputIndex, itemId),
  };
};

const openRefusal = (state: OpenAIChatCompletionsToOpenAIResponsesStreamState): { item: PendingRefusalItem; events: OpenAIResponsesStreamEvent[] } => {
  if (state.openRefusal) return { item: state.openRefusal, events: [] };

  const outputIndex = state.outputIndex++;
  const itemId = createRandomOpenAIResponsesItemId('message');
  const item = { outputIndex, itemId, refusal: '' };
  state.openRefusal = item;

  return {
    item,
    events: openaiResponses.refusalStart(state, outputIndex, itemId),
  };
};

const startFunctionCall = (current: PendingFunctionCallItem, state: OpenAIChatCompletionsToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  if (current.streamItem || !current.callId || !current.name) {
    return [];
  }

  const isCustom = state.customToolNames.has(current.name);
  const outputIndex = state.outputIndex++;
  const streamItem: FunctionCallStreamItem = {
    outputIndex,
    itemId: createRandomOpenAIResponsesItemId(isCustom ? 'custom_tool_call' : 'function_call'),
    kind: isCustom ? 'custom' : 'function',
  };
  current.streamItem = streamItem;

  if (isCustom) {
    // Wrapped custom tool calls buffer arguments fully; we cannot emit input
    // deltas until we can parse the JSON wrap and extract the freeform value.
    return openaiResponses.itemAdded(state, outputIndex, openaiResponses.customToolCallItem(streamItem.itemId, current.callId, current.name, ''));
  }

  const events = openaiResponses.itemAdded(state, outputIndex, openaiResponses.functionCallItem(streamItem.itemId, current.callId, current.name, '', 'in_progress'));

  if (current.arguments) {
    events.push(...openaiResponses.argumentsDelta(state, outputIndex, streamItem.itemId, current.arguments));
  }

  return events;
};

const emitContentDelta = (content: string, state: OpenAIChatCompletionsToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  const events = closeRefusal(state);
  const opened = openText(state);
  opened.item.text += content;
  state.outputText += content;
  events.push(...opened.events, ...openaiResponses.textDelta(state, opened.item.outputIndex, opened.item.itemId, content));

  return events;
};

const emitRefusalDelta = (refusal: string, state: OpenAIChatCompletionsToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  const events = closeText(state);
  const opened = openRefusal(state);
  opened.item.refusal += refusal;
  events.push(...opened.events);
  if (refusal.length > 0) {
    events.push(...openaiResponses.refusalDelta(state, opened.item.outputIndex, opened.item.itemId, refusal));
  }
  return events;
};

const emitToolCallsDelta = (toolCalls: OpenAIChatCompletionsStreamToolCalls, state: OpenAIChatCompletionsToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  const events: OpenAIResponsesStreamEvent[] = [];
  events.push(...closeText(state));
  events.push(...closeRefusal(state));

  for (const toolCall of toolCalls) {
    const current = state.openFunctionCalls.get(toolCall.index) ?? {
      arguments: '',
    };

    if (toolCall.id) current.callId = toolCall.id;
    // OpenAI's documented OpenAI Chat Completions stream contract delivers each tool
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

    // Wrapped custom tool calls have no live delta on the OpenAI OpenAIResponses side; the
    // freeform input is extracted at close time. Function tools keep streaming.
    if (current.streamItem?.kind === 'function') {
      events.push(...openaiResponses.argumentsDelta(state, current.streamItem.outputIndex, current.streamItem.itemId, toolCall.function.arguments));
    }
  }

  return events;
};

const commitReasoningAndReplayDeferredDeltas = (state: OpenAIChatCompletionsToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  const events: OpenAIResponsesStreamEvent[] = [];
  events.push(...commitPendingScalarReasoning(state));

  const deferred = state.deferredAfterReasoning;
  state.deferredAfterReasoning = [];

  for (const item of deferred) {
    switch (item.type) {
    case 'content':
      events.push(...emitContentDelta(item.content, state));
      break;
    case 'refusal':
      events.push(...emitRefusalDelta(item.refusal, state));
      break;
    case 'tool_calls':
      events.push(...emitToolCallsDelta(item.toolCalls, state));
      break;
    }
  }

  return events;
};

const finalize = (state: OpenAIChatCompletionsToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  if (state.completed || state.pendingFinishReason === undefined) return [];

  const events = [...commitReasoningAndReplayDeferredDeltas(state), ...closeText(state), ...closeRefusal(state), ...closeFunctionCalls(state)];

  state.completed = true;
  const incomplete = state.pendingFinishReason === 'length';
  const status: OpenAIResponsesResult['status'] = incomplete ? 'incomplete' : 'completed';

  return [...events, ...openaiResponses.terminal(state, buildResult(state, status))];
};

export const translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents = (chunk: OpenAIChatCompletionsStreamEvent, state: OpenAIChatCompletionsToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
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
        // richer item-level `reasoning_items[]` carrier later. OpenAI OpenAIResponses SSE
        // items are not retractable, so scalar reasoning remains buffered until
        // either a carrier replaces it or finalization commits it.
        state.pendingScalarReasoning = undefined;
      } else {
        events.push(...commitReasoningAndReplayDeferredDeltas(state));
        events.push(...closeText(state));
        events.push(...closeRefusal(state));
      }

      for (const item of readableReasoningItems) {
        const outputIndex = state.outputIndex++;
        events.push(...emitCompletedReasoningItem(toOpenAIResponsesReasoningItem<OpenAIResponsesOutputReasoning>(item), outputIndex, state));
      }

      if (hadPendingScalarReasoning) {
        events.push(...commitReasoningAndReplayDeferredDeltas(state));
      }
    } else if (choice.delta.reasoning_text) {
      if (!state.reasoningItemsSeen) {
        if (!state.pendingScalarReasoning) {
          events.push(...closeText(state));
          events.push(...closeRefusal(state));
        }
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

    if (choice.delta.refusal !== undefined && choice.delta.refusal !== null) {
      if (state.pendingScalarReasoning) {
        state.deferredAfterReasoning.push({
          type: 'refusal',
          refusal: choice.delta.refusal,
        });
      } else {
        events.push(...emitRefusalDelta(choice.delta.refusal, state));
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

export const flushOpenAIChatCompletionsToOpenAIResponsesEvents = (state: OpenAIChatCompletionsToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => finalize(state);

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  customToolNames: ReadonlySet<string> = new Set(),
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
  const state = createOpenAIChatCompletionsToOpenAIResponsesStreamState(customToolNames);

  for await (const chunk of upstreamChatCompletionEventsUntilDone(frames)) {
    for (const event of translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents(chunk, state)) {
      yield eventFrame(event);
    }
  }

  for (const event of flushOpenAIChatCompletionsToOpenAIResponsesEvents(state)) {
    yield eventFrame(event);
  }
};
