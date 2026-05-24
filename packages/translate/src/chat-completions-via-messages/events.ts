import type { ChatCompletionChunk, ChatCompletionResponse, Delta } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesResponse, MessagesStreamEventData } from '@floway-dev/protocols/messages';

const mapMessagesStopReasonToChatCompletionsFinishReason = (stopReason: MessagesResponse['stop_reason']): ChatCompletionResponse['choices'][0]['finish_reason'] => {
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

const upstreamMessagesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>): AsyncGenerator<MessagesStreamEventData> {
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
  reasoningBlockIndex?: number;
}

export const createMessagesToChatCompletionsStreamState = (): MessagesToChatCompletionsStreamState => ({
  messageId: '',
  model: '',
  created: Math.floor(Date.now() / 1000),
  nextToolCallIndex: 0,
  promptTokens: 0,
  cachedPromptTokens: 0,
});

const claimReasoningBlock = (state: MessagesToChatCompletionsStreamState, index: number): boolean => {
  state.reasoningBlockIndex ??= index;
  return state.reasoningBlockIndex === index;
};

const makeChunk = (state: MessagesToChatCompletionsStreamState, delta: Delta, finishReason: ChatCompletionChunk['choices'][0]['finish_reason'] = null): ChatCompletionChunk => ({
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

const makeUsageChunk = (state: MessagesToChatCompletionsStreamState, outputTokens: number): ChatCompletionChunk => ({
  id: state.messageId,
  object: 'chat.completion.chunk',
  created: state.created,
  model: state.model,
  choices: [],
  usage: {
    prompt_tokens: state.promptTokens,
    completion_tokens: outputTokens,
    total_tokens: state.promptTokens + outputTokens,
    ...(state.cachedPromptTokens > 0
      ? {
          prompt_tokens_details: {
            cached_tokens: state.cachedPromptTokens,
          },
        }
      : {}),
  },
});

const unexpectedMessagesVariant = (value: never): never => {
  throw new Error(`Unexpected Messages stream variant: ${JSON.stringify(value)}`);
};

export const translateMessagesEventToChatCompletionsChunks = (event: MessagesStreamEventData, state: MessagesToChatCompletionsStreamState): ChatCompletionChunk[] | 'DONE' => {
  switch (event.type) {
  case 'message_start': {
    state.messageId = event.message.id;
    state.model = event.message.model;
    state.cachedPromptTokens = event.message.usage.cache_read_input_tokens ?? 0;
    state.promptTokens = event.message.usage.input_tokens + state.cachedPromptTokens + (event.message.usage.cache_creation_input_tokens ?? 0);
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
      return [];
    }

    return unexpectedMessagesVariant(delta);
  }

  case 'content_block_stop':
    return [];

  case 'message_delta': {
    const chunk = makeChunk(state, {}, mapMessagesStopReasonToChatCompletionsFinishReason(event.delta.stop_reason ?? null));

    return event.usage ? [chunk, makeUsageChunk(state, event.usage.output_tokens)] : [chunk];
  }

  case 'message_stop':
    return 'DONE';

  case 'ping':
  case 'error':
    return [];
  }
};

const throwOnMessagesFatalEvent = (event: MessagesStreamEventData): void => {
  if (event.type !== 'error') return;

  throw new Error(`Upstream Messages stream error: ${event.error.type}: ${event.error.message}`, { cause: event });
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>): AsyncGenerator<ProtocolFrame<ChatCompletionChunk>> {
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
