import { anthropicMessagesRefusalExplanation } from '../shared/via-anthropic-messages/refusal.ts';
import { openAIServiceTierFromAnthropicMessagesUsage } from '../shared/via-anthropic-messages/service-tier.ts';
import { inclusiveAnthropicMessagesInputUsage } from '../shared/via-anthropic-messages/usage.ts';
import { mergeAnthropicMessagesUsageSnapshot, anthropicMessagesUsageSnapshot, type AnthropicMessagesResult, type AnthropicMessagesStreamEvent, type AnthropicMessagesUsageSnapshot } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsResult, OpenAIChatCompletionsDelta } from '@floway-dev/protocols/openai-chat-completions';

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
  reasoningBlockIndex?: number;
}

export const createAnthropicMessagesToOpenAIChatCompletionsStreamState = (): AnthropicMessagesToOpenAIChatCompletionsStreamState => ({
  messageId: '',
  model: '',
  created: Math.floor(Date.now() / 1000),
  nextToolCallIndex: 0,
  usage: anthropicMessagesUsageSnapshot(),
});

const claimReasoningBlock = (state: AnthropicMessagesToOpenAIChatCompletionsStreamState, index: number): boolean => {
  state.reasoningBlockIndex ??= index;
  return state.reasoningBlockIndex === index;
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

export const translateAnthropicMessagesEventToOpenAIChatCompletionsChunks = (event: AnthropicMessagesStreamEvent, state: AnthropicMessagesToOpenAIChatCompletionsStreamState): OpenAIChatCompletionsStreamEvent[] | 'DONE' => {
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
      // OpenAI Chat Completions has no equivalent of Anthropic's structured citation
      // annotations (no `output_text.annotation.added` event, no
      // `url_citation` annotation type, no `tool_result.search_result` block
      // shape). Blanket-drop every citation delta — the cited text already
      // appears inline in earlier `text_delta` events that the model wrote,
      // so the downstream Chat client still sees the substantive content,
      // just without per-span source attribution. Permanent limitation; the
      // OpenAI-Responses-shape translator at
      // `openai-responses-via-anthropic-messages/events.ts:handleTextCitation` DOES translate
      // these into `url_citation` annotations because OpenAI Responses has the
      // annotation surface.
      return [];
    }

    return unexpectedAnthropicMessagesVariant(delta);
  }

  case 'content_block_stop':
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
