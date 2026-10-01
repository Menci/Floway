import { anthropicMessagesRefusalExplanation } from '../shared/via-anthropic-messages/refusal.ts';
import { openAIServiceTierFromAnthropicMessagesUsage } from '../shared/via-anthropic-messages/service-tier.ts';
import { inclusiveAnthropicMessagesInputUsage } from '../shared/via-anthropic-messages/usage.ts';
import { mergeAnthropicMessagesUsageSnapshot, anthropicMessagesUsageSnapshot, type AnthropicMessagesResult, type AnthropicMessagesStreamEvent, type AnthropicMessagesUsageSnapshot } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { encodeChatCompletionsReasoningData, flowayReasoningFields } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsResult, OpenAIChatCompletionsDelta, ReasoningRecord } from '@floway-dev/protocols/openai-chat-completions';

const mapAnthropicMessagesStopReasonToOpenAIChatCompletionsFinishReason = (stopReason: AnthropicMessagesResult['stop_reason']): OpenAIChatCompletionsResult['choices'][0]['finish_reason'] => {
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

const UPSTREAM_ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE = 'Upstream Anthropic Messages stream ended without a message_stop event.';

const upstreamAnthropicMessagesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEvent>>): AsyncGenerator<AnthropicMessagesStreamEvent> {
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
  thinkingBlocks: Map<number, ReasoningRecord>;
  webSearchResults: Record<string, unknown>[];
  toolIndexes: Map<number, number>;
  toolArgumentsStarted: Set<number>;
  lastOpaque?: string;
}

export const createAnthropicMessagesToOpenAIChatCompletionsStreamState = (): AnthropicMessagesToOpenAIChatCompletionsStreamState => ({
  messageId: '',
  model: '',
  created: Math.floor(Date.now() / 1000),
  nextToolCallIndex: 0,
  usage: anthropicMessagesUsageSnapshot(),
  thinkingBlocks: new Map(),
  webSearchResults: [],
  toolIndexes: new Map(),
  toolArgumentsStarted: new Set(),
});

// LiteLLM carries only thinking/redacted blocks, separately from text and tools.
// https://github.com/BerriAI/litellm/blob/0980f756bd031993329eb0b8b2caa193047e6465/litellm/llms/anthropic/chat/transformation.py#L2183-L2255
const captureThinkingEvent = (event: AnthropicMessagesStreamEvent, state: AnthropicMessagesToOpenAIChatCompletionsStreamState): boolean => {
  if (event.type === 'content_block_start') {
    if (event.content_block.type !== 'thinking' && event.content_block.type !== 'redacted_thinking') return false;
    state.thinkingBlocks.set(event.index, { ...event.content_block });
    return true;
  }
  if (event.type !== 'content_block_delta' && event.type !== 'content_block_stop') return false;
  const block = state.thinkingBlocks.get(event.index);
  if (block === undefined) return false;
  if (event.type === 'content_block_delta') {
    if (event.delta.type === 'thinking_delta') block.thinking = (block.thinking as string) + event.delta.thinking;
    if (event.delta.type === 'signature_delta') block.signature = typeof block.signature === 'string' ? block.signature + event.delta.signature : event.delta.signature;
  }
  return true;
};

const makeChunk = (state: AnthropicMessagesToOpenAIChatCompletionsStreamState, delta: OpenAIChatCompletionsDelta, finishReason: OpenAIChatCompletionsStreamEvent['choices'][0]['finish_reason'] = null): OpenAIChatCompletionsStreamEvent => ({
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

const translateContentEvent = (event: AnthropicMessagesStreamEvent, state: AnthropicMessagesToOpenAIChatCompletionsStreamState): OpenAIChatCompletionsStreamEvent[] | 'DONE' => {
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
      return block.thinking ? [makeChunk(state, flowayReasoningFields(block.thinking, ''))] : [];
    case 'redacted_thinking':
      return [];
    case 'server_tool_use':
    case 'tool_use': {
      const toolCallIndex = state.nextToolCallIndex++;
      state.toolIndexes.set(event.index, toolCallIndex);
      if (Object.keys(block.input).length > 0) state.toolArgumentsStarted.add(event.index);
      return [
        makeChunk(state, {
          tool_calls: [
            {
              index: toolCallIndex,
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : '' },
            },
          ],
        }),
      ];
    }
    case 'text': return block.text ? [makeChunk(state, { content: block.text })] : [];
    case 'web_search_tool_result':
      state.webSearchResults.push({ ...block });
      return [makeChunk(state, { provider_specific_fields: { web_search_results: [...state.webSearchResults] } })];
    case 'fallback':
      state.model = block.to.model;
      return [];
    }

    return unexpectedAnthropicMessagesVariant(block);
  }

  case 'content_block_delta': {
    const { delta } = event;
    switch (delta.type) {
    case 'thinking_delta':
      return [makeChunk(state, flowayReasoningFields(delta.thinking, ''))];
    case 'signature_delta':
      return [];
    case 'text_delta':
      return [makeChunk(state, { content: delta.text })];
    case 'input_json_delta':
      if (!state.toolIndexes.has(event.index)) return [];
      if (delta.partial_json !== '') state.toolArgumentsStarted.add(event.index);
      return [
        makeChunk(state, {
          tool_calls: [
            {
              index: state.toolIndexes.get(event.index)!,
              function: { arguments: delta.partial_json },
            },
          ],
        }),
      ];
    case 'citations_delta':
      return [];
    }

    return unexpectedAnthropicMessagesVariant(delta);
  }

  case 'content_block_stop':
    if (state.toolIndexes.has(event.index) && !state.toolArgumentsStarted.has(event.index)) {
      state.toolArgumentsStarted.add(event.index);
      return [makeChunk(state, { tool_calls: [{ index: state.toolIndexes.get(event.index)!, function: { arguments: '{}' } }] })];
    }
    return [];

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

const throwOnAnthropicMessagesFatalEvent = (event: AnthropicMessagesStreamEvent): void => {
  if (event.type !== 'error') return;

  throw new Error(`Upstream Anthropic Messages stream error: ${event.error.type}: ${event.error.message}`, { cause: event });
};

export const translateAnthropicMessagesEventToOpenAIChatCompletionsChunks = (event: AnthropicMessagesStreamEvent, state: AnthropicMessagesToOpenAIChatCompletionsStreamState): OpenAIChatCompletionsStreamEvent[] | 'DONE' => {
  const changed = captureThinkingEvent(event, state);
  const chunks = translateContentEvent(event, state);
  if (chunks === 'DONE') return chunks;
  const snapshot = changed && (event.type === 'content_block_stop' || event.type === 'content_block_start' && event.content_block.type === 'redacted_thinking' || event.type === 'content_block_delta' && event.delta.type === 'signature_delta') || event.type === 'message_delta';
  if (snapshot && state.thinkingBlocks.size > 0) {
    const opaque = encodeChatCompletionsReasoningData('litellm-thinking-blocks', [...state.thinkingBlocks.entries()].toSorted(([left], [right]) => left - right).map(([, block]) => block));
    if (opaque !== state.lastOpaque) {
      state.lastOpaque = opaque;
      chunks.unshift(makeChunk(state, flowayReasoningFields('', opaque)));
    }
  }
  return chunks;
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEvent>>): AsyncGenerator<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> {
  const state = createAnthropicMessagesToOpenAIChatCompletionsStreamState();

  for await (const event of upstreamAnthropicMessagesEventsUntilTerminal(frames)) {
    throwOnAnthropicMessagesFatalEvent(event);

    const translated = translateAnthropicMessagesEventToOpenAIChatCompletionsChunks(event, state);

    if (translated === 'DONE') {
      yield doneFrame();
      continue;
    }

    for (const chunk of translated) {
      yield eventFrame(chunk);
    }
  }
};
