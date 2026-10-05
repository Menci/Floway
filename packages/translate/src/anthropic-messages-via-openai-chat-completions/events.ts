import { createChatStreamLifecycle, type ChatStreamLifecycleEvent, type ChatStreamSegment } from '../shared/openai-chat-completions/lifecycle.ts';
import { createAnthropicMessagesUsage, toAnthropicMessagesUsageDelta, type AnthropicMessagesStreamEventEx, type AnthropicMessagesResult } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, splitCacheWriteTokens, splitInclusiveInputTokens, type ProtocolFrame } from '@floway-dev/protocols/common';
import { OpenAIChatCompletionsAssistantMessagePrivate, accumulateOpenAIChatCompletionsPrivate, finalizeOpenAIChatCompletionsPrivate, type OpenAIChatCompletionsPrivateDraft, type OpenAIChatCompletionsAssistantDelta, type OpenAIChatCompletionsUsageEx, type OpenAIChatCompletionsPrivateContext, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

const toAnthropicMessagesId = (id: string): string => (id.startsWith('msg_') ? id : `msg_${id.replace(/^chatcmpl-/, '')}`);

const mapOpenAIChatCompletionsFinishReasonToAnthropicMessagesStopReason = (finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | null): AnthropicMessagesResult['stop_reason'] => {
  if (finishReason === null) return null;

  switch (finishReason) {
  case 'stop':
    return 'end_turn';
  case 'length':
    return 'max_tokens';
  case 'function_call':
  case 'tool_calls':
    return 'tool_use';
  case 'content_filter':
    return 'refusal';
  }
};

// OpenAI-shaped upstreams piggyback Anthropic-style cache buckets on
// `prompt_tokens_details`. `prompt_tokens` already includes both
// `cached_tokens` (reads) and `cache_creation_input_tokens` (writes); we
// subtract both to derive Anthropic's plain-input bucket and surface the cache
// buckets separately so downstream Anthropic Messages clients see the same split they
// would have seen on a native Anthropic Messages upstream. The reverse direction at
// packages/translate/src/openai-chat-completions-via-anthropic-messages/events.ts (state init in
// translateAnthropicMessagesEventToOpenAIChatCompletionsChunks) already folds both buckets back
// into prompt_tokens, so this closes a real asymmetry. Ref:
// https://github.com/caozhiyuan/copilot-api/commit/a99c23551b0f3198d78dd51142dd0096cc6da049
export const mapOpenAIChatCompletionsUsageToAnthropicMessagesUsage = (usage?: OpenAIChatCompletionsUsageEx | null): AnthropicMessagesResult['usage'] => {
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens;
  const cacheCreationTokens = usage?.prompt_tokens_details?.cache_creation_input_tokens
    ?? usage?.prompt_tokens_details?.cache_write_tokens;
  const writes = splitCacheWriteTokens(cacheCreationTokens, 0);
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
    ...createAnthropicMessagesUsage(input, usage?.completion_tokens ?? 0),
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

const anthropicMessagesUsageWithTier = (
  state: OpenAIChatCompletionsToAnthropicMessagesStreamState,
  usage: OpenAIChatCompletionsStreamEvent['usage'],
): AnthropicMessagesResult['usage'] => {
  const mapped = mapOpenAIChatCompletionsUsageToAnthropicMessagesUsage(usage);
  if (state.upstreamServiceTier === 'fast') mapped.speed = 'fast';
  else if (state.upstreamServiceTier !== undefined) mapped.service_tier = state.upstreamServiceTier;
  return mapped;
};

const ensureMessageStart = (
  state: OpenAIChatCompletionsToAnthropicMessagesStreamState,
  events: AnthropicMessagesStreamEventEx[],
): void => {
  if (state.messageStartSent) return;
  if (state.upstreamId === undefined || state.upstreamModel === undefined) {
    throw new Error('OpenAI Chat Completions stream identity is unavailable before message_start');
  }

  events.push({
    type: 'message_start',
    message: {
      id: toAnthropicMessagesId(state.upstreamId),
      type: 'message',
      role: 'assistant',
      content: [],
      model: state.upstreamModel,
      stop_reason: null,
      stop_details: null,
      container: null,
      diagnostics: null,
      stop_sequence: null,
      usage: anthropicMessagesUsageWithTier(state, state.pendingUsage),
    },
  });
  state.messageStartSent = true;
  state.lastReportedUsageOutputTokens = state.pendingUsage?.completion_tokens ?? 0;
};

// `continuous_usage_stats` upstreams repeat cumulative counters on every chunk.
// Anthropic permits multiple `message_delta` events that repeat cumulative
// whole-message counters.
const emitUsageProgress = (
  state: OpenAIChatCompletionsToAnthropicMessagesStreamState,
  events: AnthropicMessagesStreamEventEx[],
): void => {
  if (state.messageStartSent === false || state.finalMessageSent === true || state.pendingUsage == null) return;

  const outputTokens = state.pendingUsage.completion_tokens;
  const advanced = state.lastReportedUsageOutputTokens === undefined || outputTokens > state.lastReportedUsageOutputTokens;
  if (advanced === false) return;

  state.lastReportedUsageOutputTokens = outputTokens;
  events.push({
    type: 'message_delta',
    delta: { container: null, stop_reason: null, stop_details: null, stop_sequence: null },
    usage: toAnthropicMessagesUsageDelta(anthropicMessagesUsageWithTier(state, state.pendingUsage)),
  });
};

interface OpenAIChatCompletionsToAnthropicMessagesStreamState {
  messageStartSent: boolean;
  lifecycle: ReturnType<typeof createChatStreamLifecycle>;
  nextBlockIndex: number;
  privateState: OpenAIChatCompletionsPrivateDraft;
  pendingFinishReason?: OpenAIChatCompletionsStreamEvent['choices'][0]['finish_reason'];
  refusalText: string;
  sawRefusal: boolean;
  pendingUsage?: OpenAIChatCompletionsStreamEvent['usage'];
  upstreamId?: string;
  upstreamModel?: string;
  lastReportedUsageOutputTokens?: number;
  upstreamServiceTier?: string;
  finalMessageSent?: boolean;
}

const lifecycleEvents = (changes: ChatStreamLifecycleEvent[], state: OpenAIChatCompletionsToAnthropicMessagesStreamState): AnthropicMessagesStreamEventEx[] => changes.flatMap<AnthropicMessagesStreamEventEx>(change => {
  const { slot } = change;
  state.nextBlockIndex = Math.max(state.nextBlockIndex, slot.index + 1);
  if (change.type === 'close') return [
    ...(slot.kind === 'reasoning' ? [{ type: 'content_block_delta' as const, index: slot.index, delta: { type: 'signature_delta' as const, signature: '' } }] : []),
    { type: 'content_block_stop', index: slot.index },
  ];
  if (change.type === 'open') return [{
    type: 'content_block_start', index: slot.index,
    content_block: slot.kind === 'reasoning' ? { type: 'thinking', thinking: '', signature: '' }
      : slot.kind === 'tool' ? { type: 'tool_use', id: change.id!, name: change.name!, input: {} }
        : { type: 'text', text: '', citations: null },
  }];
  return [{
    type: 'content_block_delta', index: slot.index,
    delta: slot.kind === 'reasoning' ? { type: 'thinking_delta', thinking: change.text }
      : slot.kind === 'tool' ? { type: 'input_json_delta', partial_json: change.text }
        : { type: 'text_delta', text: change.text },
  }];
});

const emitFinalMessageIfReady = (state: OpenAIChatCompletionsToAnthropicMessagesStreamState, events: AnthropicMessagesStreamEventEx[]): void => {
  if (state.finalMessageSent === true || !state.messageStartSent) return;

  const usage = toAnthropicMessagesUsageDelta(anthropicMessagesUsageWithTier(state, state.pendingUsage));

  const refused = state.sawRefusal || state.pendingFinishReason === 'content_filter';

  events.push(
    {
      type: 'message_delta',
      delta: {
        container: null,
        stop_reason: refused ? 'refusal' : mapOpenAIChatCompletionsFinishReasonToAnthropicMessagesStopReason(state.pendingFinishReason === undefined ? 'stop' : state.pendingFinishReason),
        stop_details: refused ? { type: 'refusal', category: null, explanation: state.refusalText || null } : null,
        stop_sequence: null,
      },
      usage,
    },
    { type: 'message_stop' },
  );

  state.finalMessageSent = true;
  state.pendingFinishReason = undefined;
};

export const createOpenAIChatCompletionsToAnthropicMessagesStreamState = (): OpenAIChatCompletionsToAnthropicMessagesStreamState => ({
  messageStartSent: false, nextBlockIndex: 0,
  lifecycle: createChatStreamLifecycle(index => console.warn(`Ignoring data for closed Chat tool call ${index}`)),
  refusalText: '', sawRefusal: false, privateState: {},
});

export const translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents = (chunk: OpenAIChatCompletionsStreamEvent, state: OpenAIChatCompletionsToAnthropicMessagesStreamState): AnthropicMessagesStreamEventEx[] => {
  const events: AnthropicMessagesStreamEventEx[] = [];
  state.upstreamId ??= chunk.id;
  state.upstreamModel ??= chunk.model;
  if (chunk.service_tier != null) state.upstreamServiceTier = chunk.service_tier;
  if (chunk.usage !== undefined) state.pendingUsage = chunk.usage;
  // Messages represents one alternative, so other Chat choices do not contribute blocks.
  const choice = chunk.choices[0];
  if (choice !== undefined) {
    const { delta } = choice;
    const privateDelta = (delta as OpenAIChatCompletionsAssistantDelta)[OpenAIChatCompletionsAssistantMessagePrivate];
    const segments: ChatStreamSegment[] = [];
    if (privateDelta !== undefined) {
      accumulateOpenAIChatCompletionsPrivate(state.privateState, privateDelta);
      if (privateDelta.reasoningText) segments.push({ kind: 'reasoning', text: privateDelta.reasoningText });
    }
    if (typeof delta.content === 'string') segments.push({ kind: 'text', text: delta.content });
    for (const call of delta.tool_calls ?? []) segments.push({ kind: 'tool', index: call.index, id: call.id, name: call.function?.name, arguments: call.function?.arguments });
    if (delta.refusal != null) {
      state.sawRefusal = true;
      state.refusalText += delta.refusal;
    }
    if (choice.finish_reason != null) state.pendingFinishReason = choice.finish_reason;
    if (!state.messageStartSent && (segments.length > 0 || privateDelta !== undefined || choice.finish_reason != null || chunk.usage !== undefined || delta.refusal != null)) ensureMessageStart(state, events);
    events.push(...lifecycleEvents(state.lifecycle.accept(segments), state));
  } else if (!state.messageStartSent && chunk.usage !== undefined) ensureMessageStart(state, events);
  emitUsageProgress(state, events);
  return events;
};

export const flushOpenAIChatCompletionsToAnthropicMessagesEvents = (state: OpenAIChatCompletionsToAnthropicMessagesStreamState): AnthropicMessagesStreamEventEx[] => {
  if (state.finalMessageSent === true) return [];
  const events = lifecycleEvents(state.lifecycle.finish(), state);
  emitFinalMessageIfReady(state, events);
  return events;
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>, context: OpenAIChatCompletionsPrivateContext): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEventEx>> {
  const state = createOpenAIChatCompletionsToAnthropicMessagesStreamState();
  for await (const frame of frames) {
    if (frame.type === 'done') break;
    for (const event of translateOpenAIChatCompletionsChunkToAnthropicMessagesEvents(frame.event, state)) yield eventFrame(event);
  }
  for (const event of lifecycleEvents(state.lifecycle.finish(), state)) yield eventFrame(event);
  const privateState = finalizeOpenAIChatCompletionsPrivate(state.privateState);
  if (privateState !== undefined) {
    const data = await context.codec.encapsulate(privateState);
    yield eventFrame({ type: 'content_block_start', index: state.nextBlockIndex, content_block: { type: 'redacted_thinking', data } });
    yield eventFrame({ type: 'content_block_stop', index: state.nextBlockIndex });
  }
  for (const event of flushOpenAIChatCompletionsToAnthropicMessagesEvents(state)) yield eventFrame(event);
};
