import { createAnthropicMessagesPrivateState, observeAnthropicMessagesPrivate, finalizeAnthropicMessagesPrivate, recordAnthropicMessagesChatProjection } from '../shared/via-anthropic-messages/assistant-message-private.ts';
import { anthropicMessagesRefusalExplanation } from '../shared/via-anthropic-messages/refusal.ts';
import { openAIServiceTierFromAnthropicMessagesUsage } from '../shared/via-anthropic-messages/service-tier.ts';
import { inclusiveAnthropicMessagesInputUsage } from '../shared/via-anthropic-messages/usage.ts';
import { mergeAnthropicMessagesUsageSnapshot, anthropicMessagesUsageSnapshot, type AnthropicMessagesResult, type AnthropicMessagesStreamEventEx, type AnthropicMessagesUsageSnapshot } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { OpenAIChatCompletionsAssistantMessagePrivate, type OpenAIChatCompletionsStreamEvent, type OpenAIChatCompletionsResult, type OpenAIChatCompletionsAssistantDelta } from '@floway-dev/protocols/openai-chat-completions';

const mapAnthropicMessagesStopReasonToOpenAIChatCompletionsFinishReason = (stopReason: AnthropicMessagesResult['stop_reason']): OpenAIChatCompletionsResult['choices'][0]['finish_reason'] => {
  switch (stopReason) {
  case null:
  case 'end_turn':
  case 'stop_sequence':
  case 'model_context_window_exceeded':
  case 'compaction':
  case 'pause_turn':
  case 'refusal':
    return 'stop';
  case 'max_tokens':
    return 'length';
  case 'tool_use':
    return 'tool_calls';
  }
};

const UPSTREAM_ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE = 'Upstream Anthropic Messages stream ended without a message_stop event.';

const upstreamAnthropicMessagesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>): AsyncGenerator<AnthropicMessagesStreamEventEx> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;

    yield frame.event;
    if (frame.event.type === 'message_stop' || frame.event.type === 'error') {
      return;
    }
  }

  throw new Error(UPSTREAM_ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE);
};

interface AnthropicMessagesToOpenAIChatCompletionsStreamState {
  messageId: string;
  model: string;
  created: number;
  nextToolCallIndex: number;
  usage: AnthropicMessagesUsageSnapshot;
  privateState: ReturnType<typeof createAnthropicMessagesPrivateState>;
  toolCallIndices: Map<number, number>;
  toolArgumentsSeen: Set<number>;
}

export const createAnthropicMessagesToOpenAIChatCompletionsStreamState = (): AnthropicMessagesToOpenAIChatCompletionsStreamState => ({
  messageId: '',
  model: '',
  created: Math.floor(Date.now() / 1000),
  nextToolCallIndex: 0,
  privateState: createAnthropicMessagesPrivateState(), toolCallIndices: new Map(), toolArgumentsSeen: new Set(),
  usage: anthropicMessagesUsageSnapshot(),
});

const makeChunk = (state: AnthropicMessagesToOpenAIChatCompletionsStreamState, delta: OpenAIChatCompletionsAssistantDelta, finishReason: OpenAIChatCompletionsStreamEvent['choices'][0]['finish_reason'] = null): OpenAIChatCompletionsStreamEvent => ({
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

const makeUsageChunk = (state: AnthropicMessagesToOpenAIChatCompletionsStreamState): OpenAIChatCompletionsStreamEvent => {
  const { cacheRead: cachedPromptTokens, cacheWrite, cacheWrite1h, inclusiveInput: promptTokens } = inclusiveAnthropicMessagesInputUsage(state.usage);
  const cacheCreationPromptTokens = cacheWrite + cacheWrite1h;
  const serviceTier = openAIServiceTierFromAnthropicMessagesUsage(state.usage);

  return {
    id: state.messageId,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: state.usage.output_tokens,
      total_tokens: promptTokens + state.usage.output_tokens,
      ...(cachedPromptTokens > 0 || cacheCreationPromptTokens > 0
        ? {
            prompt_tokens_details: {
              ...(cachedPromptTokens > 0 ? { cached_tokens: cachedPromptTokens } : {}),
              ...(cacheCreationPromptTokens > 0 ? { cache_creation_input_tokens: cacheCreationPromptTokens } : {}),
            },
          }
        : {}),
    },
    ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
  };
};

const unexpectedAnthropicMessagesVariant = (value: never): never => {
  throw new Error(`Unexpected Anthropic Messages stream variant: ${JSON.stringify(value)}`);
};

const translateAnthropicMessagesEvent = (event: AnthropicMessagesStreamEventEx, state: AnthropicMessagesToOpenAIChatCompletionsStreamState): OpenAIChatCompletionsStreamEvent[] | 'DONE' => {
  const reasoningText = observeAnthropicMessagesPrivate(event, state.privateState);
  switch (event.type) {
  case 'message_start': {
    state.messageId = event.message.id;
    state.model = event.message.model;
    state.usage = anthropicMessagesUsageSnapshot(event.message.usage);
    return [makeChunk(state, { role: 'assistant' })];
  }

  case 'content_block_start': {
    const { content_block: block } = event;

    switch (block.type) {
    case 'thinking':
      return reasoningText !== undefined ? [makeChunk(state, { [OpenAIChatCompletionsAssistantMessagePrivate]: { reasoningText } })] : [];
    case 'redacted_thinking':
      return [];
    case 'tool_use': {
      const toolCallIndex = state.nextToolCallIndex++;
      state.toolCallIndices.set(event.index, toolCallIndex);
      const args = Object.keys(block.input as Record<string, unknown>).length > 0 ? JSON.stringify(block.input) : '';
      if (args) state.toolArgumentsSeen.add(event.index);
      return [
        makeChunk(state, {
          tool_calls: [
            {
              index: toolCallIndex,
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: args },
            },
          ],
        }),
      ];
    }
    case 'text':
      return block.text ? [makeChunk(state, { content: block.text })] : [];
    case 'server_tool_use':
    case 'web_search_tool_result':
      return [];
    case 'fallback':
      state.model = block.to.model;
      return [];
    }

    return [];
  }

  case 'content_block_delta': {
    const { delta } = event;
    switch (delta.type) {
    case 'thinking_delta':
      return [makeChunk(state, { [OpenAIChatCompletionsAssistantMessagePrivate]: { reasoningText: delta.thinking } })];
    case 'signature_delta':
      return [];
    case 'text_delta':
      return [makeChunk(state, { content: delta.text })];
    case 'input_json_delta': {
      const index = state.toolCallIndices.get(event.index);
      if (index === undefined) return [];
      state.toolArgumentsSeen.add(event.index);
      return [
        makeChunk(state, {
          tool_calls: [
            {
              index,
              function: { arguments: delta.partial_json },
            },
          ],
        }),
      ];
    }
    case 'compaction_delta':
      return [];
    case 'citations_delta':
      return [];
    }

    return unexpectedAnthropicMessagesVariant(delta);
  }

  case 'content_block_stop': {
    const index = state.toolCallIndices.get(event.index);
    if (index !== undefined && !state.toolArgumentsSeen.has(event.index)) {
      state.toolArgumentsSeen.add(event.index);
      return [makeChunk(state, { tool_calls: [{ index, function: { arguments: '{}' } }] })];
    }
    return [];
  }

  case 'message_delta': {
    const chunks: OpenAIChatCompletionsStreamEvent[] = [];
    if (event.delta.stop_reason === 'refusal') {
      chunks.push(makeChunk(state, { refusal: anthropicMessagesRefusalExplanation(event.delta.stop_details) }));
    }
    chunks.push(makeChunk(state, {}, mapAnthropicMessagesStopReasonToOpenAIChatCompletionsFinishReason(event.delta.stop_reason ?? null)));

    if (event.usage) {
      state.usage = mergeAnthropicMessagesUsageSnapshot(state.usage, event.usage);
      chunks.push(makeUsageChunk(state));
    }

    return chunks;
  }

  case 'message_stop':
    return 'DONE';

  case 'ping':
  case 'error':
    return [];
  }
};

export const translateAnthropicMessagesEventToOpenAIChatCompletionsChunks = (event: AnthropicMessagesStreamEventEx, state: AnthropicMessagesToOpenAIChatCompletionsStreamState): OpenAIChatCompletionsStreamEvent[] | 'DONE' => {
  const chunks = translateAnthropicMessagesEvent(event, state);
  if (chunks !== 'DONE') recordAnthropicMessagesChatProjection(event, chunks, state.privateState);
  return chunks;
};

const throwOnAnthropicMessagesFatalEvent = (event: AnthropicMessagesStreamEventEx): void => {
  if (event.type !== 'error') return;

  throw new Error(`Upstream Anthropic Messages stream error: ${event.error.type}: ${event.error.message}`, { cause: event });
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  const state = createAnthropicMessagesToOpenAIChatCompletionsStreamState();

  for await (const event of upstreamAnthropicMessagesEventsUntilTerminal(frames)) {
    throwOnAnthropicMessagesFatalEvent(event);

    const translated = translateAnthropicMessagesEventToOpenAIChatCompletionsChunks(event, state);

    if (translated === 'DONE') {
      const sidecar = finalizeAnthropicMessagesPrivate(state.privateState);
      if (sidecar !== undefined) yield eventFrame(makeChunk(state, { [OpenAIChatCompletionsAssistantMessagePrivate]: { sidecar } }));
      yield doneFrame();
      continue;
    }

    for (const chunk of translated) {
      yield eventFrame(chunk);
    }
  }
};
