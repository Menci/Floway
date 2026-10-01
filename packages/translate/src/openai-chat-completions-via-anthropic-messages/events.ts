import { anthropicMessagesRefusalExplanation } from '../shared/via-anthropic-messages/refusal.ts';
import { openAIServiceTierFromAnthropicMessagesUsage } from '../shared/via-anthropic-messages/service-tier.ts';
import { inclusiveAnthropicMessagesInputUsage } from '../shared/via-anthropic-messages/usage.ts';
import { mergeAnthropicMessagesUsageSnapshot, anthropicMessagesUsageSnapshot, type AnthropicMessagesResult, type AnthropicMessagesStreamEvent, type AnthropicMessagesUsageSnapshot } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { encodeChatCompletionsReasoningData, flowayReasoningFields } from '@floway-dev/protocols/openai-chat-completions';
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
  contentBlocks: (Record<string, unknown> | undefined)[];
  toolArguments: Map<number, string>;
  toolIndexes: Map<number, number>;
  fallbackIndexes: Set<number>;
  lastOpaque?: string;
  hasReasoning: boolean;
}

export const createAnthropicMessagesToOpenAIChatCompletionsStreamState = (): AnthropicMessagesToOpenAIChatCompletionsStreamState => ({
  messageId: '',
  model: '',
  created: Math.floor(Date.now() / 1000),
  nextToolCallIndex: 0,
  usage: anthropicMessagesUsageSnapshot(),
  contentBlocks: [],
  toolArguments: new Map(),
  toolIndexes: new Map(),
  fallbackIndexes: new Set(),
  hasReasoning: false,
});

// Signed thinking can depend on its position among text and tools, so the
// Chat history carrier retains complete native content rather than a sidecar.
// https://github.com/BerriAI/litellm/issues/13834
// https://github.com/BerriAI/litellm/issues/23047
const captureContentEvent = (event: AnthropicMessagesStreamEvent, state: AnthropicMessagesToOpenAIChatCompletionsStreamState): boolean => {
  if (event.type === 'content_block_start') {
    if (event.content_block.type === 'fallback') { state.fallbackIndexes.add(event.index); return false; }
    state.contentBlocks[event.index] = { ...event.content_block };
    if (event.content_block.type === 'thinking' || event.content_block.type === 'redacted_thinking') state.hasReasoning = true;
    return true;
  }
  if (event.type !== 'content_block_delta' && event.type !== 'content_block_stop') return false;
  if (state.fallbackIndexes.has(event.index)) return false;
  const block = state.contentBlocks[event.index];
  if (block === undefined) throw new TypeError(`Missing Anthropic Messages content block ${event.index}`);
  if (event.type === 'content_block_stop') {
    const json = state.toolArguments.get(event.index);
    if (json !== undefined) block.input = JSON.parse(json);
    return true;
  }
  const delta = event.delta;
  switch (delta.type) {
  case 'text_delta': block.text = (block.text as string) + delta.text; break;
  case 'thinking_delta': block.thinking = (block.thinking as string) + delta.thinking; break;
  case 'signature_delta': block.signature = typeof block.signature === 'string' ? block.signature + delta.signature : delta.signature; break;
  case 'input_json_delta': state.toolArguments.set(event.index, (state.toolArguments.get(event.index) ?? '') + delta.partial_json); break;
  case 'citations_delta': block.citations = [...(Array.isArray(block.citations) ? block.citations : []), delta.citation]; break;
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
    case 'tool_use': {
      const toolCallIndex = state.nextToolCallIndex++;
      state.toolIndexes.set(event.index, toolCallIndex);
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
      return [makeChunk(state, flowayReasoningFields(delta.thinking, ''))];
    case 'signature_delta':
      return [];
    case 'text_delta':
      return [makeChunk(state, { content: delta.text })];
    case 'input_json_delta':
      if (!state.toolIndexes.has(event.index)) return [];
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
      // Chat has no presentation field for citations. Ordered native content
      // retains them in the internal history carrier when reasoning is present.
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

export const translateAnthropicMessagesEventToOpenAIChatCompletionsChunks = (event: AnthropicMessagesStreamEvent, state: AnthropicMessagesToOpenAIChatCompletionsStreamState): OpenAIChatCompletionsStreamEvent[] | 'DONE' => {
  const changed = captureContentEvent(event, state);
  const chunks = translateContentEvent(event, state);
  if (chunks === 'DONE') return chunks;
  const snapshot = changed && (event.type === 'content_block_stop' || event.type === 'content_block_start' && event.content_block.type === 'redacted_thinking' || event.type === 'content_block_delta' && event.delta.type === 'signature_delta') || event.type === 'message_delta';
  if (snapshot && state.hasReasoning) {
    const opaque = encodeChatCompletionsReasoningData('anthropic-messages-content-blocks', state.contentBlocks.filter(block => block !== undefined));
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
