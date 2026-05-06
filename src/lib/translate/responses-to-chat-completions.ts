import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
  ChatReasoningItem,
  ContentPart,
  Delta,
  Message,
  Tool,
  ToolCall,
} from "../chat-completions-types.ts";
import type {
  ResponseFunctionTool,
  ResponseInputContent,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseOutputReasoning,
  ResponsesPayload,
  ResponsesResult,
  ResponseStreamEvent,
  ResponseTool,
  ResponseToolChoice,
} from "../responses-types.ts";
import {
  createResponsesOutputOrderState,
  recordResponseOutputOrderEvent,
  responsePartKey,
  type ResponsesOutputOrderState,
  shouldDeferForEarlierResponseOutput,
} from "./responses-stream-order.ts";

const toChatCompletionsContent = (
  content: string | ResponseInputContent[],
): string | ContentPart[] => {
  if (typeof content === "string") return content;

  const parts: ContentPart[] = [];

  for (const part of content) {
    if (part.type === "input_text" || part.type === "output_text") {
      parts.push({ type: "text", text: part.text });
      continue;
    }

    if (part.type !== "input_image") continue;

    parts.push({
      type: "image_url",
      image_url: {
        url: part.image_url,
        detail: part.detail,
      },
    });
  }

  return parts.some((part) => part.type === "image_url") ? parts : parts
    .filter((part): part is Extract<ContentPart, { type: "text" }> =>
      part.type === "text"
    )
    // Assumption: Responses text parts are transport fragments of one
    // message, not paragraph-level blocks. Keep the current no-separator
    // join unless upstream semantics prove otherwise.
    .map((part) => part.text)
    .join("");
};

const toAssistantText = (
  content: string | ResponseInputContent[],
): string => {
  if (typeof content === "string") return content;

  return content
    .filter((part): part is Extract<ResponseInputContent, { text: string }> =>
      part.type === "input_text" || part.type === "output_text"
    )
    // Same assumption as above: these parts are one message's text fragments,
    // so we preserve the existing no-separator flattening.
    .map((part) => part.text)
    .join("");
};

interface AssistantAccumulator {
  message: Message;
  hasScalarReasoning: boolean;
}

type ChatReasoningSourceItem =
  | Extract<ResponseInputItem, { type: "reasoning" }>
  | ResponseOutputReasoning;

const ensureAssistant = (
  assistant: AssistantAccumulator | null,
): AssistantAccumulator =>
  assistant ?? {
    message: { role: "assistant", content: null },
    hasScalarReasoning: false,
  };

const appendAssistantText = (
  assistant: AssistantAccumulator | null,
  text: string,
): AssistantAccumulator | null => {
  if (!text) return assistant;

  const next = ensureAssistant(assistant);
  next.message.content = typeof next.message.content === "string"
    ? next.message.content + text
    : text;
  return next;
};

const appendAssistantReasoning = (
  assistant: AssistantAccumulator | null,
  item: Extract<ResponseInputItem, { type: "reasoning" }>,
): AssistantAccumulator => {
  const next = ensureAssistant(assistant);
  const reasoningText = item.summary.map((part) => part.text).join("");
  const reasoningItem = toChatReasoningItem(item);
  // Preserve item-level reasoning instead of compressing all Responses reasoning
  // into legacy scalar Chat fields.
  next.message.reasoning_items = [
    ...(next.message.reasoning_items ?? []),
    reasoningItem,
  ];

  const hasEncryptedContent = Object.hasOwn(item, "encrypted_content");
  if (!next.hasScalarReasoning && (reasoningText || hasEncryptedContent)) {
    if (reasoningText) next.message.reasoning_text = reasoningText;
    if (hasEncryptedContent) {
      next.message.reasoning_opaque = item.encrypted_content;
    }
    next.hasScalarReasoning = true;
  }

  return next;
};

const toChatReasoningItem = (
  item: ChatReasoningSourceItem,
): ChatReasoningItem => ({
  type: "reasoning",
  id: item.id,
  summary: item.summary,
  ...(item.encrypted_content !== undefined
    ? { encrypted_content: item.encrypted_content }
    : {}),
});

const appendAssistantToolCall = (
  assistant: AssistantAccumulator | null,
  item: Extract<ResponseInputItem, { type: "function_call" }>,
): AssistantAccumulator => {
  const next = ensureAssistant(assistant);
  next.message.tool_calls = [
    ...(next.message.tool_calls ?? []),
    {
      id: item.call_id,
      type: "function",
      function: {
        name: item.name,
        arguments: item.arguments,
      },
    } satisfies ToolCall,
  ];
  return next;
};

const translateResponseTools = (
  tools?: ResponseTool[] | null,
): Tool[] | undefined =>
  tools?.length
    ? tools.filter((tool): tool is ResponseFunctionTool =>
      tool.type === "function"
    ).map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        parameters: tool.parameters,
        strict: tool.strict,
        ...(tool.description ? { description: tool.description } : {}),
      },
    }))
    : undefined;

const translateResponseToolChoice = (
  choice?: ResponseToolChoice,
): ChatCompletionsPayload["tool_choice"] =>
  choice == null
    ? undefined
    : typeof choice === "string"
    ? choice
    : choice.type === "web_search"
    ? undefined
    : { type: "function", function: { name: choice.name } };

const buildChatResponseFormat = (
  text: ResponsesPayload["text"],
): ChatCompletionsPayload["response_format"] | undefined => {
  if (text === undefined) return undefined;
  if (text === null) return null;
  // `text: {}` means no explicit format. Keep it omitted instead of converting
  // absence into an explicit Chat `response_format: null`.
  if (!Object.hasOwn(text, "format")) return undefined;
  if (text.format === undefined) return undefined;
  return text.format;
};

export const translateResponsesToChatCompletions = (
  payload: ResponsesPayload,
): ChatCompletionsPayload => {
  const responseFormat = buildChatResponseFormat(payload.text);
  const messages: Message[] = payload.instructions
    ? [{ role: "system", content: payload.instructions }]
    : [];

  if (typeof payload.input === "string") {
    messages.push({ role: "user", content: payload.input });
  } else {
    let assistant: AssistantAccumulator | null = null;
    const flushAssistant = () => {
      if (!assistant) return;
      messages.push(assistant.message);
      assistant = null;
    };

    for (const item of payload.input) {
      if (item.type === "reasoning") {
        assistant = appendAssistantReasoning(assistant, item);
        continue;
      }

      if (item.type === "function_call") {
        assistant = appendAssistantToolCall(assistant, item);
        continue;
      }

      if (item.type === "function_call_output") {
        flushAssistant();
        messages.push({
          role: "tool",
          tool_call_id: item.call_id,
          content: item.output,
        });
        continue;
      }

      // item_reference items are connection-bound pointers with no inline
      // content to translate; skip them.
      if (item.type === "item_reference") continue;
      if (item.type === "web_search_call") continue;

      if (item.role === "assistant") {
        assistant = appendAssistantText(
          assistant,
          toAssistantText(item.content),
        );
        continue;
      }

      flushAssistant();
      messages.push({
        role: item.role,
        content: toChatCompletionsContent(item.content),
      });
    }

    flushAssistant();
  }

  // Same-purpose OpenAI fields pass through directly here, while broader
  // Responses-only state such as `previous_response_id` remains native-only.
  return {
    model: payload.model,
    messages,
    ...(payload.max_output_tokens !== undefined
      ? { max_tokens: payload.max_output_tokens }
      : {}),
    ...(payload.stream !== undefined ? { stream: payload.stream } : {}),
    ...(payload.temperature !== undefined
      ? { temperature: payload.temperature }
      : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
    ...(payload.store !== undefined ? { store: payload.store } : {}),
    ...(payload.parallel_tool_calls !== undefined
      ? { parallel_tool_calls: payload.parallel_tool_calls }
      : {}),
    ...(responseFormat !== undefined
      ? { response_format: responseFormat }
      : {}),
    ...(payload.prompt_cache_key !== undefined
      ? { prompt_cache_key: payload.prompt_cache_key }
      : {}),
    ...(payload.safety_identifier !== undefined
      ? { safety_identifier: payload.safety_identifier }
      : {}),
    ...(payload.reasoning?.effort != null
      ? { reasoning_effort: payload.reasoning.effort }
      : {}),
    ...(payload.service_tier !== undefined
      ? { service_tier: payload.service_tier }
      : {}),
    // Chat Completions has no request-level counterpart for Responses
    // `reasoning`; only explicit reasoning items survive this translation.
    tools: translateResponseTools(payload.tools),
    tool_choice: translateResponseToolChoice(payload.tool_choice),
  };
};

const mapFinishReason = (
  response: ResponsesResult,
): ChatCompletionResponse["choices"][0]["finish_reason"] => {
  if (response.status === "completed") {
    return response.output.some((item) => item.type === "function_call")
      ? "tool_calls"
      : "stop";
  }

  if (
    response.status === "incomplete" &&
    response.incomplete_details?.reason === "max_output_tokens"
  ) {
    return "length";
  }

  return "stop";
};

export const translateResponsesToChatCompletion = (
  response: ResponsesResult,
): ChatCompletionResponse => {
  let content = "";
  const toolCalls: ToolCall[] = [];
  const reasoningItems: ChatReasoningItem[] = [];
  let reasoningText: string | undefined;
  let reasoningOpaque: string | undefined;
  let hasScalarReasoning = false;

  // Preserve every reasoning item, and expose only the first scalar group through
  // legacy `reasoning_text` / `reasoning_opaque` fields.
  for (const item of response.output) {
    if (item.type === "message") {
      for (const block of item.content) {
        if (block.type === "output_text") {
          content += block.text;
          continue;
        }

        // Compromise: our local Chat shape has no dedicated refusal field, so
        // keep refusal text visible rather than inventing extra translated
        // semantics at this boundary.
        content += block.refusal;
      }
      continue;
    }

    if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      });
      continue;
    }
    if (item.type === "web_search_call") continue;

    reasoningItems.push(toChatReasoningItem(item));
    const text = item.summary.map((part) => part.text).join("");
    const hasEncryptedContent = Object.hasOwn(item, "encrypted_content");
    if (!hasScalarReasoning && (text || hasEncryptedContent)) {
      if (text) reasoningText = text;
      if (hasEncryptedContent) reasoningOpaque = item.encrypted_content;
      hasScalarReasoning = true;
    }
  }

  if (!content && response.output_text) {
    content = response.output_text;
  }

  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  const cachedTokens = response.usage?.input_tokens_details?.cached_tokens;

  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(reasoningText !== undefined
          ? { reasoning_text: reasoningText }
          : {}),
        ...(reasoningOpaque !== undefined
          ? { reasoning_opaque: reasoningOpaque }
          : {}),
        ...(reasoningItems.length > 0
          ? { reasoning_items: reasoningItems }
          : {}),
      },
      finish_reason: mapFinishReason(response),
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      ...(cachedTokens !== undefined
        ? { prompt_tokens_details: { cached_tokens: cachedTokens } }
        : {}),
    },
  };
};

interface ResponsesToChatCompletionsStreamState {
  messageId: string;
  model: string;
  created: number;
  toolCallIndex: number;
  functionCallIndices: Map<number, number>;
  inputTokens: number;
  cachedTokens: number;
  reasoningItems: ChatReasoningItem[];
  firstScalarReasoningOutputIndex?: number;
  pendingReasoningSummaryTexts: Map<string, {
    outputIndex: number;
    summaryIndex: number;
    text: string;
  }>;
  emittedReasoningSummaryKeys: Set<string>;
  emittedTextContentKeys: Set<string>;
  emittedFunctionArgumentOutputIndexes: Set<number>;
  outputOrder: ResponsesOutputOrderState;
  done: boolean;
}

export const createResponsesToChatCompletionsStreamState =
  (): ResponsesToChatCompletionsStreamState => ({
    messageId: "",
    model: "",
    created: Math.floor(Date.now() / 1000),
    toolCallIndex: -1,
    functionCallIndices: new Map(),
    inputTokens: 0,
    cachedTokens: 0,
    reasoningItems: [],
    pendingReasoningSummaryTexts: new Map(),
    emittedReasoningSummaryKeys: new Set(),
    emittedTextContentKeys: new Set(),
    emittedFunctionArgumentOutputIndexes: new Set(),
    outputOrder: createResponsesOutputOrderState(),
    done: false,
  });

const shouldDeferForEarlierReasoning = (
  event: ResponseStreamEvent,
  state: ResponsesToChatCompletionsStreamState,
): boolean => shouldDeferForEarlierResponseOutput(event, state.outputOrder);

const trackReasoningOutputItem = (item: ResponseOutputItem): boolean =>
  item.type === "reasoning";

const flushPendingReasoningChunks = (
  state: ResponsesToChatCompletionsStreamState,
): ChatCompletionChunk[] => {
  const chunks: ChatCompletionChunk[] = [];

  if (state.reasoningItems.length > 0) {
    chunks.push(makeChunk(state, { reasoning_items: state.reasoningItems }));
    state.reasoningItems = [];
  }

  return chunks;
};

const shouldProjectScalarReasoning = (
  outputIndex: number,
  state: ResponsesToChatCompletionsStreamState,
): boolean => {
  // Chat scalar reasoning is a compatibility projection, not an ordered
  // reasoning IR; once the first Responses reasoning output is chosen, later
  // reasoning outputs only travel through `reasoning_items[]`.
  state.firstScalarReasoningOutputIndex ??= outputIndex;
  return state.firstScalarReasoningOutputIndex === outputIndex;
};

const emitReasoningSummaryDelta = (
  outputIndex: number,
  summaryIndex: number,
  text: string,
  state: ResponsesToChatCompletionsStreamState,
): ChatCompletionChunk[] => {
  if (!text || !shouldProjectScalarReasoning(outputIndex, state)) return [];

  state.emittedReasoningSummaryKeys.add(
    responsePartKey(outputIndex, summaryIndex),
  );
  state.pendingReasoningSummaryTexts.delete(
    responsePartKey(outputIndex, summaryIndex),
  );
  return [makeChunk(state, { reasoning_text: text })];
};

const emitReasoningSummaryDoneFallback = (
  outputIndex: number,
  summaryIndex: number,
  text: string,
  state: ResponsesToChatCompletionsStreamState,
): ChatCompletionChunk[] => {
  if (!text || !shouldProjectScalarReasoning(outputIndex, state)) return [];

  const key = responsePartKey(outputIndex, summaryIndex);
  if (state.emittedReasoningSummaryKeys.has(key)) return [];

  state.emittedReasoningSummaryKeys.add(key);
  state.pendingReasoningSummaryTexts.delete(key);
  return [makeChunk(state, { reasoning_text: text })];
};

const queueReasoningSummaryDoneFallback = (
  outputIndex: number,
  summaryIndex: number,
  text: string,
  state: ResponsesToChatCompletionsStreamState,
): void => {
  if (!text || !shouldProjectScalarReasoning(outputIndex, state)) return;

  const key = responsePartKey(outputIndex, summaryIndex);
  if (state.emittedReasoningSummaryKeys.has(key)) return;

  state.pendingReasoningSummaryTexts.set(key, {
    outputIndex,
    summaryIndex,
    text,
  });
};

const flushPendingReasoningSummaryDoneFallbacks = (
  outputIndex: number,
  state: ResponsesToChatCompletionsStreamState,
): ChatCompletionChunk[] => {
  const pending = [...state.pendingReasoningSummaryTexts.values()]
    .filter((item) => item.outputIndex === outputIndex)
    .sort((a, b) => a.summaryIndex - b.summaryIndex);

  return pending.flatMap((item) =>
    emitReasoningSummaryDoneFallback(
      item.outputIndex,
      item.summaryIndex,
      item.text,
      state,
    )
  );
};

const flushAllPendingReasoningSummaryDoneFallbacks = (
  state: ResponsesToChatCompletionsStreamState,
): ChatCompletionChunk[] => {
  const pending = [...state.pendingReasoningSummaryTexts.values()]
    .sort((a, b) =>
      a.outputIndex === b.outputIndex
        ? a.summaryIndex - b.summaryIndex
        : a.outputIndex - b.outputIndex
    );

  return pending.flatMap((item) =>
    emitReasoningSummaryDoneFallback(
      item.outputIndex,
      item.summaryIndex,
      item.text,
      state,
    )
  );
};

const flushDeferredEvents = (
  state: ResponsesToChatCompletionsStreamState,
): ChatCompletionChunk[] => {
  const chunks: ChatCompletionChunk[] = [];

  while (state.outputOrder.deferredEvents.length > 0) {
    const ready: ResponseStreamEvent[] = [];
    const stillDeferred: ResponseStreamEvent[] = [];

    for (const event of state.outputOrder.deferredEvents) {
      if (shouldDeferForEarlierReasoning(event, state)) {
        stillDeferred.push(event);
      } else {
        ready.push(event);
      }
    }

    if (ready.length === 0) break;
    state.outputOrder.deferredEvents = stillDeferred;

    for (const event of ready) {
      const translated = translateResponsesEventToChatCompletionsChunks(
        event,
        state,
      );
      chunks.push(...translated);
    }
  }

  return chunks;
};

export const translateResponsesEventToChatCompletionsChunks = (
  event: ResponseStreamEvent,
  state: ResponsesToChatCompletionsStreamState,
): ChatCompletionChunk[] => {
  if (state.done) return [];
  if (shouldDeferForEarlierReasoning(event, state)) {
    state.outputOrder.deferredEvents.push(event);
    return [];
  }
  recordResponseOutputOrderEvent(
    event,
    state.outputOrder,
    trackReasoningOutputItem,
  );

  switch (event.type) {
    case "response.created": {
      const { response } = event as Extract<
        ResponseStreamEvent,
        { type: "response.created" }
      >;
      state.messageId = response.id;
      state.model = response.model;
      state.inputTokens = response.usage?.input_tokens ?? 0;
      state.cachedTokens =
        response.usage?.input_tokens_details?.cached_tokens ?? 0;
      return [makeChunk(state, { role: "assistant" })];
    }

    case "response.output_item.added": {
      const { item, output_index } = event as Extract<
        ResponseStreamEvent,
        { type: "response.output_item.added" }
      >;
      if (item.type === "reasoning") {
        return [];
      }

      if (item.type !== "function_call") return [];

      state.toolCallIndex++;
      state.functionCallIndices.set(output_index, state.toolCallIndex);

      return [makeChunk(state, {
        tool_calls: [{
          index: state.toolCallIndex,
          id: item.call_id,
          type: "function",
          function: {
            name: item.name,
            arguments: "",
          },
        }],
      })];
    }

    case "response.output_item.done": {
      const { item, output_index } = event as Extract<
        ResponseStreamEvent,
        { type: "response.output_item.done" }
      >;
      if (item.type !== "reasoning") return [];

      const chunks: ChatCompletionChunk[] = [];
      state.reasoningItems.push(toChatReasoningItem(item));

      for (const [summaryIndex, part] of item.summary.entries()) {
        chunks.push(...emitReasoningSummaryDoneFallback(
          output_index,
          summaryIndex,
          part.text,
          state,
        ));
      }
      chunks.push(...flushPendingReasoningSummaryDoneFallbacks(
        output_index,
        state,
      ));

      if (
        Object.hasOwn(item, "encrypted_content") &&
        shouldProjectScalarReasoning(output_index, state)
      ) {
        chunks.push(makeChunk(state, {
          reasoning_opaque: item.encrypted_content,
        }));
      }

      const deferred = flushDeferredEvents(state);
      return [...chunks, ...flushPendingReasoningChunks(state), ...deferred];
    }

    case "response.reasoning_summary_text.delta": {
      const { delta, output_index, summary_index } = event as Extract<
        ResponseStreamEvent,
        { type: "response.reasoning_summary_text.delta" }
      >;
      return emitReasoningSummaryDelta(
        output_index,
        summary_index,
        delta,
        state,
      );
    }

    case "response.reasoning_summary_text.done": {
      const { text, output_index, summary_index } = event as Extract<
        ResponseStreamEvent,
        { type: "response.reasoning_summary_text.done" }
      >;
      queueReasoningSummaryDoneFallback(
        output_index,
        summary_index,
        text,
        state,
      );
      return [];
    }

    case "response.output_text.delta": {
      const { delta, output_index, content_index } = event as Extract<
        ResponseStreamEvent,
        { type: "response.output_text.delta" }
      >;
      if (delta) {
        state.emittedTextContentKeys.add(
          responsePartKey(output_index, content_index),
        );
      }
      return delta ? [makeChunk(state, { content: delta })] : [];
    }

    case "response.output_text.done": {
      const { text, output_index, content_index } = event as Extract<
        ResponseStreamEvent,
        { type: "response.output_text.done" }
      >;
      const key = responsePartKey(output_index, content_index);
      if (!text || state.emittedTextContentKeys.has(key)) return [];

      state.emittedTextContentKeys.add(key);
      return [makeChunk(state, { content: text })];
    }

    case "response.content_part.done": {
      const { part, output_index, content_index } = event as Extract<
        ResponseStreamEvent,
        { type: "response.content_part.done" }
      >;
      if (part.type !== "refusal") return [];

      const key = responsePartKey(output_index, content_index);
      if (!part.refusal || state.emittedTextContentKeys.has(key)) return [];

      state.emittedTextContentKeys.add(key);
      return [makeChunk(state, { content: part.refusal })];
    }

    case "response.function_call_arguments.delta": {
      const { delta, output_index } = event as Extract<
        ResponseStreamEvent,
        { type: "response.function_call_arguments.delta" }
      >;
      if (!delta) return [];

      const toolCallIndex = state.functionCallIndices.get(output_index);
      if (toolCallIndex === undefined) return [];

      state.emittedFunctionArgumentOutputIndexes.add(output_index);
      return [makeChunk(state, {
        tool_calls: [{
          index: toolCallIndex,
          function: { arguments: delta },
        }],
      })];
    }

    case "response.function_call_arguments.done": {
      const { arguments: args, output_index } = event as Extract<
        ResponseStreamEvent,
        { type: "response.function_call_arguments.done" }
      >;
      if (
        !args || state.emittedFunctionArgumentOutputIndexes.has(output_index)
      ) {
        return [];
      }

      const toolCallIndex = state.functionCallIndices.get(output_index);
      if (toolCallIndex === undefined) return [];

      state.emittedFunctionArgumentOutputIndexes.add(output_index);
      return [makeChunk(state, {
        tool_calls: [{
          index: toolCallIndex,
          function: { arguments: args },
        }],
      })];
    }

    case "response.completed":
    case "response.incomplete": {
      const { response } = event as Extract<
        ResponseStreamEvent,
        { type: "response.completed" | "response.incomplete" }
      >;
      const chunks: ChatCompletionChunk[] = [];

      chunks.push(...flushAllPendingReasoningSummaryDoneFallbacks(state));
      chunks.push(...flushPendingReasoningChunks(state));
      chunks.push(...flushDeferredEvents(state));

      const chunk = makeChunk(state, {}, mapFinishReason(response));

      state.done = true;
      chunks.push(chunk);
      if (response.usage) chunks.push(makeUsageChunk(state, response.usage));
      return chunks;
    }

    case "response.failed":
      state.done = true;
      return [];

    default:
      return [];
  }
};

const makeChunk = (
  state: ResponsesToChatCompletionsStreamState,
  delta: Delta,
  finishReason: ChatCompletionChunk["choices"][0]["finish_reason"] = null,
): ChatCompletionChunk => ({
  id: state.messageId,
  object: "chat.completion.chunk",
  created: state.created,
  model: state.model,
  choices: [{
    index: 0,
    delta,
    finish_reason: finishReason,
  }],
});

const makeUsageChunk = (
  state: ResponsesToChatCompletionsStreamState,
  usage: NonNullable<ResponsesResult["usage"]>,
): ChatCompletionChunk => ({
  id: state.messageId,
  object: "chat.completion.chunk",
  created: state.created,
  model: state.model,
  choices: [],
  usage: {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.input_tokens_details?.cached_tokens !== undefined
      ? {
        prompt_tokens_details: {
          cached_tokens: usage.input_tokens_details.cached_tokens,
        },
      }
      : {}),
  },
});
