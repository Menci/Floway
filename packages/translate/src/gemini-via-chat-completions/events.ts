import { flushGeminiThoughtSignature, type GeminiThoughtSignatureState, parseStrictJsonObject, setGeminiThoughtSignature, signGeminiPart } from '../shared/gemini-via/gemini.ts';
import { chatCompletionsErrorPayloadMessage } from '@floway-dev/protocols/chat-completions';
import type { ChatCompletionsStreamEvent, ChatCompletionsDelta } from '@floway-dev/protocols/chat-completions';
import { billableServiceTier, eventFrame, splitCacheWriteTokens, splitInclusiveInputTokens, splitInclusiveOutputTokens, USAGE_BILLING, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiCandidate, GeminiFinishReason, GeminiResult, GeminiPart, GeminiStreamEvent, GeminiUsageMetadata } from '@floway-dev/protocols/gemini';

type ChatCompletionsStreamChoice = ChatCompletionsStreamEvent['choices'][0];

const mapFinishReason = (finishReason: ChatCompletionsStreamChoice['finish_reason']): GeminiFinishReason | undefined => {
  switch (finishReason) {
  case 'stop':
  case 'tool_calls':
    return 'STOP';
  case 'length':
    return 'MAX_TOKENS';
  case 'content_filter':
    return 'SAFETY';
  default:
    return undefined;
  }
};

// OpenAI prompt_tokens already includes prompt_tokens_details.cached_tokens,
// matching Gemini's inclusive promptTokenCount semantics. Pass both through
// directly — no folding. Contrast with gemini-via-messages, where Anthropic's
// input_tokens excludes cache buckets and must be summed.
const mapUsage = (
  chunk: ChatCompletionsStreamEvent,
  upstreamServiceTier: ChatCompletionsStreamEvent['service_tier'],
): GeminiUsageMetadata | undefined => {
  const usage = chunk.usage;
  if (!usage) return undefined;

  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  const cacheWriteTokens = usage.prompt_tokens_details?.cache_creation_input_tokens
    ?? usage.prompt_tokens_details?.cache_write_tokens;
  const writes = splitCacheWriteTokens(cacheWriteTokens, usage[USAGE_BILLING]);
  splitInclusiveInputTokens(usage.prompt_tokens, cachedTokens, cacheWriteTokens);
  const { output: candidatesTokenCount, reasoning: thoughtsTokenCount } = splitInclusiveOutputTokens(
    usage.completion_tokens,
    usage.completion_tokens_details?.reasoning_tokens,
  );
  const serviceTier = billableServiceTier(upstreamServiceTier);

  const metadata: GeminiUsageMetadata = {
    promptTokenCount: usage.prompt_tokens,
    candidatesTokenCount,
    totalTokenCount: usage.total_tokens,
  };

  if (usage.completion_tokens_details?.reasoning_tokens !== undefined) {
    metadata.thoughtsTokenCount = thoughtsTokenCount;
  }

  if (cachedTokens !== undefined) {
    metadata.cachedContentTokenCount = cachedTokens;
  }
  if (cacheWriteTokens !== undefined || serviceTier !== null) {
    metadata[USAGE_BILLING] = {
      ...(cacheWriteTokens !== undefined ? { cacheWriteTokenCount: writes.cacheWrite } : {}),
      ...(writes.cacheWrite1h > 0 ? { cacheWrite1hTokenCount: writes.cacheWrite1h } : {}),
      ...(serviceTier !== null ? { serviceTier } : {}),
    };
  }

  return metadata;
};

const UPSTREAM_CHAT_COMPLETIONS_MISSING_DONE_MESSAGE = 'Upstream Chat Completions stream ended without a DONE sentinel.';

const upstreamChatCompletionEventsUntilDone = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>): AsyncGenerator<ChatCompletionsStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') return;
    yield frame.event;
  }

  throw new Error(UPSTREAM_CHAT_COMPLETIONS_MISSING_DONE_MESSAGE);
};

type ChatCompletionsToolCallDelta = NonNullable<ChatCompletionsDelta['tool_calls']>[0];

interface ChatCompletionsToolCallDraft {
  id?: string;
  name?: string;
  argsJson: string;
}

interface ChatCompletionsToGeminiStreamState extends GeminiThoughtSignatureState {
  toolCalls: Record<number, ChatCompletionsToolCallDraft>;
}

const getChatCompletionsToGeminiStreamState = (states: Record<number, ChatCompletionsToGeminiStreamState>, index: number): ChatCompletionsToGeminiStreamState => {
  states[index] ??= { toolCalls: {} };
  return states[index];
};

const accumulateToolCalls = (toolCalls: ChatCompletionsToolCallDelta[], state: ChatCompletionsToGeminiStreamState): void => {
  for (const toolCall of toolCalls) {
    const current = (state.toolCalls[toolCall.index] ??= { argsJson: '' });
    if (toolCall.id !== undefined) current.id = toolCall.id;
    if (toolCall.function?.name !== undefined) {
      current.name = toolCall.function.name;
    }
    if (toolCall.function?.arguments !== undefined) {
      current.argsJson += toolCall.function.arguments;
    }
  }
};

const flushToolCallParts = (state: ChatCompletionsToGeminiStreamState): GeminiPart[] => {
  const parts: GeminiPart[] = [];

  for (const [_index, toolCall] of Object.entries(state.toolCalls).sort(([left], [right]) => Number(left) - Number(right))) {
    if (!toolCall.name) continue;

    parts.push(
      signGeminiPart(state, {
        functionCall: {
          ...(toolCall.id !== undefined ? { id: toolCall.id } : {}),
          name: toolCall.name,
          args: toolCall.argsJson ? parseStrictJsonObject(toolCall.argsJson, 'Chat Completions tool call arguments') : {},
        },
      }),
    );
  }

  state.toolCalls = {};
  return parts;
};

const buildCandidate = (choice: ChatCompletionsStreamChoice, state: ChatCompletionsToGeminiStreamState): GeminiCandidate | null => {
  const parts: GeminiPart[] = [];
  const { delta } = choice;

  if (typeof delta.reasoning_text === 'string') {
    parts.push({ text: delta.reasoning_text, thought: true });
  }

  if (typeof delta.reasoning_opaque === 'string') {
    setGeminiThoughtSignature(state, delta.reasoning_opaque);
  }

  if (typeof delta.content === 'string') {
    parts.push(signGeminiPart(state, { text: delta.content }));
  }

  if (delta.tool_calls) accumulateToolCalls(delta.tool_calls, state);

  const finishReason = mapFinishReason(choice.finish_reason);
  if (finishReason) {
    parts.push(...flushToolCallParts(state));
    parts.push(...flushGeminiThoughtSignature(state));
  }

  if (!parts.length && !finishReason) return null;

  return {
    index: choice.index,
    content: { role: 'model', parts },
    ...(finishReason !== undefined ? { finishReason } : {}),
  };
};

const translateChunk = (
  chunk: ChatCompletionsStreamEvent,
  states: Record<number, ChatCompletionsToGeminiStreamState>,
  upstreamServiceTier: ChatCompletionsStreamEvent['service_tier'],
): GeminiResult | null => {
  const candidates: GeminiCandidate[] = [];

  for (const choice of chunk.choices) {
    const candidate = buildCandidate(choice, getChatCompletionsToGeminiStreamState(states, choice.index));

    if (candidate) candidates.push(candidate);
  }

  const usageMetadata = mapUsage(chunk, upstreamServiceTier);

  if (!candidates.length && !usageMetadata) return null;

  return {
    ...(candidates.length ? { candidates } : {}),
    ...(usageMetadata ? { usageMetadata } : {}),
  };
};

const throwOnChatCompletionsErrorPayload = (chunk: ChatCompletionsStreamEvent): void => {
  const message = chatCompletionsErrorPayloadMessage(chunk);
  if (!message) return;

  throw new Error(`Upstream Chat Completions stream error: ${message}`, {
    cause: chunk,
  });
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
  const states: Record<number, ChatCompletionsToGeminiStreamState> = {};
  let pendingUsageMetadata: GeminiUsageMetadata | undefined;
  let upstreamServiceTier: ChatCompletionsStreamEvent['service_tier'];
  const deferredFinalCandidates: GeminiCandidate[] = [];

  for await (const chunk of upstreamChatCompletionEventsUntilDone(frames)) {
    throwOnChatCompletionsErrorPayload(chunk);
    if (chunk.service_tier !== undefined) upstreamServiceTier = chunk.service_tier;

    const result = translateChunk(chunk, states, upstreamServiceTier);
    if (!result) continue;

    if (result.usageMetadata) {
      pendingUsageMetadata = result.usageMetadata;
    }

    const candidates = result.candidates ?? [];
    const finishedCandidates = candidates.filter(candidate => candidate.finishReason !== undefined);
    const nonFinalCandidates = candidates.filter(candidate => candidate.finishReason === undefined);

    if (nonFinalCandidates.length) {
      yield eventFrame({ candidates: nonFinalCandidates });
    }

    if (finishedCandidates.length) {
      deferredFinalCandidates.push(...finishedCandidates);
    }
  }

  if (deferredFinalCandidates.length) {
    yield eventFrame({
      candidates: deferredFinalCandidates,
      ...(pendingUsageMetadata ? { usageMetadata: pendingUsageMetadata } : {}),
    });
  }
};
