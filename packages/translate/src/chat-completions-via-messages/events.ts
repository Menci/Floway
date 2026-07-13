import type { ChatCompletionsStreamEvent, ChatCompletionsResult, ChatCompletionsDelta } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesResult, MessagesStreamEvent } from '@floway-dev/protocols/messages';

const mapMessagesStopReasonToChatCompletionsFinishReason = (stopReason: MessagesResult['stop_reason']): ChatCompletionsResult['choices'][0]['finish_reason'] => {
  switch (stopReason) {
  case null:
  case 'end_turn':
  case 'stop_sequence':
  case 'pause_turn':
  case 'refusal':
    return 'stop';
  case 'max_tokens':
    return 'length';
  case 'tool_use':
    return 'tool_calls';
  }
};

const UPSTREAM_MESSAGES_MISSING_TERMINAL_MESSAGE = 'Upstream Messages stream ended without a message_stop event.';

const upstreamMessagesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>): AsyncGenerator<MessagesStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;

    yield frame.event;
    if (frame.event.type === 'message_stop' || frame.event.type === 'error') {
      return;
    }
  }

  throw new Error(UPSTREAM_MESSAGES_MISSING_TERMINAL_MESSAGE);
};

interface MessagesToChatCompletionsStreamState {
  messageId: string;
  model: string;
  created: number;
  nextToolCallIndex: number;
  promptTokens: number;
  cachedPromptTokens: number;
  cacheCreationPromptTokens: number;
  reasoningBlockIndex?: number;
  // Captured from message_delta usage for service_tier pass-through.
  upstreamSpeed?: string;
  upstreamServiceTier?: string;
}

export const createMessagesToChatCompletionsStreamState = (): MessagesToChatCompletionsStreamState => ({
  messageId: '',
  model: '',
  created: Math.floor(Date.now() / 1000),
  nextToolCallIndex: 0,
  promptTokens: 0,
  cachedPromptTokens: 0,
  cacheCreationPromptTokens: 0,
});

const claimReasoningBlock = (state: MessagesToChatCompletionsStreamState, index: number): boolean => {
  state.reasoningBlockIndex ??= index;
  return state.reasoningBlockIndex === index;
};

const makeChunk = (state: MessagesToChatCompletionsStreamState, delta: ChatCompletionsDelta, finishReason: ChatCompletionsStreamEvent['choices'][0]['finish_reason'] = null): ChatCompletionsStreamEvent => ({
  id: state.messageId,
  object: 'chat.completion.chunk',
  created: state.created,
  model: state.model,
  choices: [
    {
      index: 0,
      delta,
      finish_reason: finishReason,
    },
  ],
});

const makeUsageChunk = (state: MessagesToChatCompletionsStreamState, outputTokens: number): ChatCompletionsStreamEvent => {
  // Anthropic's `speed: 'fast'` surfaces as OpenAI `service_tier: 'fast'`;
  // all other Anthropic service_tier values pass through directly.
  const serviceTier = state.upstreamSpeed === 'fast' ? 'fast' : state.upstreamServiceTier;

  return {
    id: state.messageId,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [],
    usage: {
      prompt_tokens: state.promptTokens,
      completion_tokens: outputTokens,
      total_tokens: state.promptTokens + outputTokens,
      ...(state.cachedPromptTokens > 0 || state.cacheCreationPromptTokens > 0
        ? {
            prompt_tokens_details: {
              ...(state.cachedPromptTokens > 0 ? { cached_tokens: state.cachedPromptTokens } : {}),
              ...(state.cacheCreationPromptTokens > 0 ? { cache_creation_input_tokens: state.cacheCreationPromptTokens } : {}),
            },
          }
        : {}),
    },
    ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
  };
};

const unexpectedMessagesVariant = (value: never): never => {
  throw new Error(`Unexpected Messages stream variant: ${JSON.stringify(value)}`);
};

export const translateMessagesEventToChatCompletionsChunks = (event: MessagesStreamEvent, state: MessagesToChatCompletionsStreamState): ChatCompletionsStreamEvent[] | 'DONE' => {
  switch (event.type) {
  case 'message_start': {
    state.messageId = event.message.id;
    state.model = event.message.model;
    state.cachedPromptTokens = event.message.usage.cache_read_input_tokens ?? 0;
    state.cacheCreationPromptTokens = event.message.usage.cache_creation_input_tokens ?? 0;
    state.promptTokens = event.message.usage.input_tokens + state.cachedPromptTokens + state.cacheCreationPromptTokens;
    if (event.message.usage.speed !== undefined) state.upstreamSpeed = event.message.usage.speed;
    if (event.message.usage.service_tier !== undefined) state.upstreamServiceTier = event.message.usage.service_tier;
    return [makeChunk(state, { role: 'assistant' })];
  }

  case 'content_block_start': {
    const { content_block: block } = event;

    switch (block.type) {
    case 'thinking':
      claimReasoningBlock(state, event.index);
      return [];
    case 'redacted_thinking':
      return claimReasoningBlock(state, event.index) ? [makeChunk(state, { reasoning_opaque: block.data })] : [];
    case 'tool_use': {
      const toolCallIndex = state.nextToolCallIndex++;
      return [
        makeChunk(state, {
          tool_calls: [
            {
              index: toolCallIndex,
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: '' },
            },
          ],
        }),
      ];
    }
    case 'text':
    case 'server_tool_use':
    case 'web_search_tool_result':
      return [];
    }

    return unexpectedMessagesVariant(block);
  }

  case 'content_block_delta': {
    const { delta } = event;
    switch (delta.type) {
    case 'thinking_delta':
      return state.reasoningBlockIndex === event.index ? [makeChunk(state, { reasoning_text: delta.thinking })] : [];
    case 'signature_delta':
      return state.reasoningBlockIndex === event.index ? [makeChunk(state, { reasoning_opaque: delta.signature })] : [];
    case 'text_delta':
      return [makeChunk(state, { content: delta.text })];
    case 'input_json_delta':
      return [
        makeChunk(state, {
          tool_calls: [
            {
              index: state.nextToolCallIndex - 1,
              function: { arguments: delta.partial_json },
            },
          ],
        }),
      ];
    case 'citations_delta':
      // Chat Completions has no equivalent of Anthropic's structured citation
      // annotations (no `output_text.annotation.added` event, no
      // `url_citation` annotation type, no `tool_result.search_result` block
      // shape). Blanket-drop every citation delta — the cited text already
      // appears inline in earlier `text_delta` events that the model wrote,
      // so the downstream Chat client still sees the substantive content,
      // just without per-span source attribution. Permanent limitation; the
      // Responses-shape translator at
      // `responses-via-messages/events.ts:handleTextCitation` DOES translate
      // these into `url_citation` annotations because Responses has the
      // annotation surface.
      return [];
    }

    return unexpectedMessagesVariant(delta);
  }

  case 'content_block_stop':
    return [];

  case 'message_delta': {
    const chunk = makeChunk(state, {}, mapMessagesStopReasonToChatCompletionsFinishReason(event.delta.stop_reason ?? null));

    if (event.usage) {
      if (event.usage.speed !== undefined) state.upstreamSpeed = event.usage.speed;
      if (event.usage.service_tier !== undefined) state.upstreamServiceTier = event.usage.service_tier;
      return [chunk, makeUsageChunk(state, event.usage.output_tokens)];
    }

    return [chunk];
  }

  case 'message_stop':
    return 'DONE';

  case 'ping':
  case 'error':
    return [];
  }
};

const throwOnMessagesFatalEvent = (event: MessagesStreamEvent): void => {
  if (event.type !== 'error') return;

  throw new Error(`Upstream Messages stream error: ${event.error.type}: ${event.error.message}`, { cause: event });
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {
  const state = createMessagesToChatCompletionsStreamState();

  for await (const event of upstreamMessagesEventsUntilTerminal(frames)) {
    throwOnMessagesFatalEvent(event);

    const translated = translateMessagesEventToChatCompletionsChunks(event, state);

    if (translated === 'DONE') {
      yield doneFrame();
      continue;
    }

    for (const chunk of translated) {
      yield eventFrame(chunk);
    }
  }
};
