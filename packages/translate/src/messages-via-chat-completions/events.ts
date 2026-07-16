import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { eventFrame, splitCacheWriteTokens, splitInclusiveInputTokens, USAGE_BILLING, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesContentBlockDeltaEvent, MessagesContentBlockStartEvent, MessagesResult, MessagesStreamEvent } from '@floway-dev/protocols/messages';

const toMessagesId = (id: string): string => (id.startsWith('msg_') ? id : `msg_${id.replace(/^chatcmpl-/, '')}`);

const mapChatCompletionsFinishReasonToMessagesStopReason = (finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null): MessagesResult['stop_reason'] => {
  if (finishReason === null) return null;

  switch (finishReason) {
  case 'stop':
    return 'end_turn';
  case 'length':
    return 'max_tokens';
  case 'tool_calls':
    return 'tool_use';
  case 'content_filter':
    return 'refusal';
  }
};

type ChatCompletionsUsage = NonNullable<ChatCompletionsStreamEvent['usage']>;

// OpenAI-shaped upstreams piggyback Anthropic-style cache buckets on
// `prompt_tokens_details`. `prompt_tokens` already includes both
// `cached_tokens` (reads) and `cache_creation_input_tokens` (writes); we
// subtract both to derive Anthropic's plain-input bucket and surface the cache
// buckets separately so downstream Messages clients see the same split they
// would have seen on a native Messages upstream. The reverse direction at
// packages/translate/src/chat-completions-via-messages/events.ts (state init in
// translateMessagesEventToChatCompletionsChunks) already folds both buckets back
// into prompt_tokens, so this closes a real asymmetry. Ref:
// https://github.com/caozhiyuan/copilot-api/commit/a99c23551b0f3198d78dd51142dd0096cc6da049
export const mapChatCompletionsUsageToMessagesUsage = (usage?: ChatCompletionsUsage): MessagesResult['usage'] => {
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens;
  const cacheCreationTokens = usage?.prompt_tokens_details?.cache_creation_input_tokens
    ?? usage?.prompt_tokens_details?.cache_write_tokens;
  const writes = splitCacheWriteTokens(cacheCreationTokens, usage?.[USAGE_BILLING]);
  const { input, cacheRead, cacheWrite } = splitInclusiveInputTokens(
    usage?.prompt_tokens ?? 0,
    cachedTokens,
    cacheCreationTokens,
  );

  return {
    // `cached_tokens` and `cache_creation_input_tokens` are disjoint subsets of
    // `prompt_tokens`, so the subtraction cannot go negative under any
    // standards-conforming upstream. Do NOT clamp with Math.max(0, ...) — that
    // would mask a real upstream contract violation rather than fix anything.
    input_tokens: input,
    output_tokens: usage?.completion_tokens ?? 0,
    ...(cachedTokens !== undefined ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheCreationTokens !== undefined ? { cache_creation_input_tokens: cacheWrite } : {}),
    ...(writes.cacheWrite1h > 0
      ? {
          cache_creation: {
            ephemeral_5m_input_tokens: writes.cacheWrite,
            ephemeral_1h_input_tokens: writes.cacheWrite1h,
          },
        }
      : {}),
  };
};

const UPSTREAM_CHAT_COMPLETIONS_MISSING_DONE_MESSAGE = 'Upstream Chat Completions stream ended without a DONE sentinel.';

const upstreamChatCompletionEventsUntilDone = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>): AsyncGenerator<ChatCompletionsStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') return;
    yield frame.event;
  }

  throw new Error(UPSTREAM_CHAT_COMPLETIONS_MISSING_DONE_MESSAGE);
};

type ChatCompletionsStreamDelta = ChatCompletionsStreamEvent['choices'][0]['delta'];
type ChatCompletionsStreamToolCalls = NonNullable<ChatCompletionsStreamDelta['tool_calls']>;
type MessagesContentBlock = MessagesContentBlockStartEvent['content_block'];
type MessagesContentDelta = MessagesContentBlockDeltaEvent['delta'];

type OpenContentBlock = 'text' | 'thinking' | 'tool_use';

interface ChatCompletionsToMessagesStreamState {
  messageStartSent: boolean;
  contentBlockIndex: number;
  openBlock?: OpenContentBlock;
  toolCalls: Record<
    number,
    {
      id: string;
      name: string;
      arguments: string;
    }
  >;
  pendingReasoningOpaque?: string;
  deferredReasoningText?: string;
  // Some OpenAI-shaped upstreams (notably gpt-4o-2024-05-13) interleave a
  // `content` delta in the middle of a tool_call's argument fragments, and
  // some chunk deltas carry BOTH `content` and `tool_calls` arrays in one
  // hit. In either case, emitting the content as a text block before /
  // around the tool_use block would force us to close the tool_use block
  // early — its trailing argument fragments would then land against a
  // stopped block index and Anthropic clients would reject them. We buffer
  // the interleaved content here and flush it after the buffered tool run. Ref:
  // https://github.com/caozhiyuan/copilot-api/commit/51675f73de7983093c857d68ddd61bcd09f1806a
  // and the broader gating that includes same-chunk content+tool_calls:
  // https://github.com/caozhiyuan/copilot-api/blob/287d2d330c299bbdf3ed213a1bc05b1739aecf03/src/routes/messages/stream-translation.ts#L232-L243
  deferredContent?: string;
  pendingFinishReason?: ChatCompletionsStreamEvent['choices'][0]['finish_reason'];
  pendingUsage?: ChatCompletionsStreamEvent['usage'];
  // Captured from any chunk's service_tier for speed pass-through.
  upstreamServiceTier?: string;
  finalMessageSent?: boolean;
}

const startContentBlock = (state: ChatCompletionsToMessagesStreamState, events: MessagesStreamEvent[], openBlock: OpenContentBlock, contentBlock: MessagesContentBlock): void => {
  events.push({
    type: 'content_block_start',
    index: state.contentBlockIndex,
    content_block: contentBlock,
  });
  state.openBlock = openBlock;
};

const emitContentBlockDelta = (state: ChatCompletionsToMessagesStreamState, events: MessagesStreamEvent[], delta: MessagesContentDelta, index = state.contentBlockIndex): void => {
  events.push({ type: 'content_block_delta', index, delta });
};

const closeCurrentBlock = (state: ChatCompletionsToMessagesStreamState, events: MessagesStreamEvent[]): void => {
  if (state.openBlock === undefined) return;

  events.push({ type: 'content_block_stop', index: state.contentBlockIndex });
  state.contentBlockIndex++;
  state.openBlock = undefined;
};

const emitPendingOpaqueReasoningBlock = (state: ChatCompletionsToMessagesStreamState, events: MessagesStreamEvent[]): void => {
  if (state.pendingReasoningOpaque === undefined) return;

  closeCurrentBlock(state, events);
  events.push(
    {
      type: 'content_block_start',
      index: state.contentBlockIndex,
      content_block: {
        type: 'redacted_thinking',
        data: state.pendingReasoningOpaque,
      },
    },
    { type: 'content_block_stop', index: state.contentBlockIndex },
  );
  state.contentBlockIndex++;
  state.pendingReasoningOpaque = undefined;
};

const emitContentDelta = (content: string, deferUntilAfterTools: boolean, state: ChatCompletionsToMessagesStreamState, events: MessagesStreamEvent[]): void => {
  // Chat tool drafts are buffered until finish. Text sharing or following the
  // draft run follows the serialized Messages tool blocks.
  // https://github.com/caozhiyuan/copilot-api/blob/287d2d330c299bbdf3ed213a1bc05b1739aecf03/src/routes/messages/stream-translation.ts#L232-L243
  if (deferUntilAfterTools) {
    state.deferredContent = (state.deferredContent ?? '') + content;
    return;
  }

  if (state.openBlock === undefined) {
    startContentBlock(state, events, 'text', { type: 'text', text: '' });
  }

  emitContentBlockDelta(state, events, {
    type: 'text_delta',
    text: content,
  });
};

const flushDeferredContent = (state: ChatCompletionsToMessagesStreamState, events: MessagesStreamEvent[]): void => {
  if (state.deferredContent === undefined) return;
  if (state.openBlock !== undefined) throw new Error('Deferred Chat content reached flush with an open Messages block');

  const text = state.deferredContent;
  state.deferredContent = undefined;
  startContentBlock(state, events, 'text', { type: 'text', text: '' });
  emitContentBlockDelta(state, events, { type: 'text_delta', text });
  closeCurrentBlock(state, events);
};

const handleReasoningDelta = (delta: ChatCompletionsStreamDelta, state: ChatCompletionsToMessagesStreamState, events: MessagesStreamEvent[]): void => {
  if (delta.reasoning_text) {
    if (Object.keys(state.toolCalls).length > 0) {
      state.deferredReasoningText = `${state.deferredReasoningText ?? ''}${delta.reasoning_text}`;
    } else {
      if (state.openBlock !== 'thinking') {
        closeCurrentBlock(state, events);
        startContentBlock(state, events, 'thinking', {
          type: 'thinking',
          thinking: '',
        });
      }

      emitContentBlockDelta(state, events, {
        type: 'thinking_delta',
        thinking: delta.reasoning_text,
      });
    }
  }

  if (delta.reasoning_opaque === undefined || delta.reasoning_opaque === null) {
    return;
  }

  state.pendingReasoningOpaque = delta.reasoning_opaque;
};

const bufferToolCallsDelta = (toolCalls: ChatCompletionsStreamToolCalls, state: ChatCompletionsToMessagesStreamState): void => {
  for (const toolCall of toolCalls) {
    if (toolCall.id && toolCall.function?.name) {
      const existing = state.toolCalls[toolCall.index];
      if (existing === undefined) {
        state.toolCalls[toolCall.index] = {
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: '',
        };
      } else if (existing.id !== toolCall.id || existing.name !== toolCall.function.name) {
        throw new Error(`Chat tool call ${toolCall.index} changed identity while streaming`);
      }
    }

    if (!toolCall.function?.arguments) continue;

    const draft = state.toolCalls[toolCall.index];
    if (draft === undefined) throw new Error(`Chat tool call ${toolCall.index} emitted arguments before its start`);
    draft.arguments += toolCall.function.arguments;
  }
};

const flushToolCalls = (state: ChatCompletionsToMessagesStreamState, events: MessagesStreamEvent[]): void => {
  if (Object.keys(state.toolCalls).length === 0) return;
  closeCurrentBlock(state, events);
  for (const [, toolCall] of Object.entries(state.toolCalls).toSorted(([left], [right]) => Number(left) - Number(right))) {
    startContentBlock(state, events, 'tool_use', {
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.name,
      input: {},
    });
    if (toolCall.arguments.length > 0) {
      emitContentBlockDelta(state, events, { type: 'input_json_delta', partial_json: toolCall.arguments });
    }
    closeCurrentBlock(state, events);
  }
  state.toolCalls = {};
};

const flushDeferredReasoning = (state: ChatCompletionsToMessagesStreamState, events: MessagesStreamEvent[]): void => {
  if (state.deferredReasoningText === undefined) return;
  startContentBlock(state, events, 'thinking', { type: 'thinking', thinking: '' });
  emitContentBlockDelta(state, events, { type: 'thinking_delta', thinking: state.deferredReasoningText });
  state.deferredReasoningText = undefined;
};

const flushPendingReasoningAndClose = (state: ChatCompletionsToMessagesStreamState, events: MessagesStreamEvent[]): void => {
  if (state.openBlock === 'thinking' && state.pendingReasoningOpaque !== undefined) {
    emitContentBlockDelta(state, events, {
      type: 'signature_delta',
      signature: state.pendingReasoningOpaque,
    });
    state.pendingReasoningOpaque = undefined;
  } else {
    emitPendingOpaqueReasoningBlock(state, events);
  }
  closeCurrentBlock(state, events);
};

const handleFinishReason = (
  finishReason: ChatCompletionsStreamEvent['choices'][0]['finish_reason'],
  chunk: ChatCompletionsStreamEvent,
  state: ChatCompletionsToMessagesStreamState,
  events: MessagesStreamEvent[],
): void => {
  flushToolCalls(state, events);
  flushDeferredReasoning(state, events);
  flushPendingReasoningAndClose(state, events);
  flushDeferredContent(state, events);

  state.pendingFinishReason = finishReason;
  if (chunk.usage) state.pendingUsage = chunk.usage;
  if (chunk.usage) emitFinalMessageIfReady(state, events);
};

const emitFinalMessageIfReady = (state: ChatCompletionsToMessagesStreamState, events: MessagesStreamEvent[]): void => {
  if (!state.pendingFinishReason || state.finalMessageSent) return;

  const usage = mapChatCompletionsUsageToMessagesUsage(state.pendingUsage);

  if (state.upstreamServiceTier === 'fast') usage.speed = 'fast';
  else if (state.upstreamServiceTier !== undefined) usage.service_tier = state.upstreamServiceTier;

  events.push(
    {
      type: 'message_delta',
      delta: {
        stop_reason: mapChatCompletionsFinishReasonToMessagesStopReason(state.pendingFinishReason),
        stop_sequence: null,
      },
      usage,
    },
    { type: 'message_stop' },
  );

  state.finalMessageSent = true;
  state.pendingFinishReason = undefined;
};

export const createChatCompletionsToMessagesStreamState = (): ChatCompletionsToMessagesStreamState => ({
  messageStartSent: false,
  contentBlockIndex: 0,
  toolCalls: {},
});

export const translateChatCompletionsChunkToMessagesEvents = (chunk: ChatCompletionsStreamEvent, state: ChatCompletionsToMessagesStreamState): MessagesStreamEvent[] => {
  const events: MessagesStreamEvent[] = [];

  if (chunk.service_tier != null) state.upstreamServiceTier = chunk.service_tier;

  if (chunk.choices.length === 0) {
    if (chunk.usage) {
      state.pendingUsage = chunk.usage;
      emitFinalMessageIfReady(state, events);
    }

    return events;
  }

  // Chat Completions `n > 1` returns alternative completions, not parts of one
  // answer. Messages has no multi-candidate shape, so only the first choice
  // can be represented; choices[1+] are dropped.
  const choice = chunk.choices[0];

  if (!state.messageStartSent) {
    events.push({
      type: 'message_start',
      message: {
        id: toMessagesId(chunk.id),
        type: 'message',
        role: 'assistant',
        content: [],
        model: chunk.model,
        stop_reason: null,
        stop_sequence: null,
        usage: mapChatCompletionsUsageToMessagesUsage(chunk.usage),
      },
    });
    state.messageStartSent = true;
  }

  handleReasoningDelta(choice.delta, state, events);

  const content = choice.delta.content;
  const toolCalls = choice.delta.tool_calls;
  const hasToolCallDelta = Boolean(toolCalls?.length);
  const hasBufferedToolCalls = Object.keys(state.toolCalls).length > 0;
  const startsToolCall = toolCalls?.some(toolCall => Boolean(toolCall.id && toolCall.function?.name)) === true;
  const startsVisibleBoundary = startsToolCall || Boolean(content && !hasBufferedToolCalls);
  if ((state.openBlock === 'thinking' || state.pendingReasoningOpaque !== undefined) && startsVisibleBoundary) {
    flushPendingReasoningAndClose(state, events);
  }

  if (content) {
    emitContentDelta(content, hasToolCallDelta || hasBufferedToolCalls, state, events);
  }

  if (toolCalls?.length) {
    if (startsToolCall) closeCurrentBlock(state, events);
    bufferToolCallsDelta(toolCalls, state);
  }

  if (choice.finish_reason) {
    handleFinishReason(choice.finish_reason, chunk, state, events);
  }

  return events;
};

// Call once after the upstream Chat stream is exhausted. Some final Messages SSE
// events are intentionally buffered until end-of-stream so late usage and
// opaque-only reasoning can be emitted in valid block/message order.
export const flushChatCompletionsToMessagesEvents = (state: ChatCompletionsToMessagesStreamState): MessagesStreamEvent[] => {
  const events: MessagesStreamEvent[] = [];
  flushToolCalls(state, events);
  flushDeferredReasoning(state, events);
  flushPendingReasoningAndClose(state, events);
  flushDeferredContent(state, events);
  emitFinalMessageIfReady(state, events);
  return events;
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
  const state = createChatCompletionsToMessagesStreamState();

  for await (const chunk of upstreamChatCompletionEventsUntilDone(frames)) {
    for (const event of translateChatCompletionsChunkToMessagesEvents(chunk, state)) {
      yield eventFrame(event);
    }
  }

  for (const event of flushChatCompletionsToMessagesEvents(state)) {
    yield eventFrame(event);
  }
};
