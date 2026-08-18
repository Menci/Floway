import { flushGeminiGenerateContentThoughtSignature, type GeminiGenerateContentThoughtSignatureState, parseStrictJsonObject, setGeminiGenerateContentThoughtSignature, signGeminiGenerateContentPart } from '../shared/gemini-generate-content-via/gemini-generate-content.ts';
import { billableServiceTier, eventFrame, splitInclusiveInputTokens, splitInclusiveOutputTokens, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentCandidate, GeminiGenerateContentFinishReason, GeminiGenerateContentResult, GeminiGenerateContentPart, GeminiGenerateContentStreamEvent, GeminiGenerateContentUsageMetadata } from '@floway-dev/protocols/gemini-generate-content';
import { openaiChatCompletionsErrorPayloadMessage } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIChatCompletionsStreamEvent, OpenAIChatCompletionsDelta } from '@floway-dev/protocols/openai-chat-completions';

type OpenAIChatCompletionsStreamChoice = OpenAIChatCompletionsStreamEvent['choices'][0];

const mapFinishReason = (finishReason: OpenAIChatCompletionsStreamChoice['finish_reason']): GeminiGenerateContentFinishReason | undefined => {
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
// directly — no folding. Contrast with gemini-generate-content-via-anthropic-messages, where Anthropic's
// input_tokens excludes cache buckets and must be summed.
const mapUsage = (
  chunk: OpenAIChatCompletionsStreamEvent,
  upstreamServiceTier: OpenAIChatCompletionsStreamEvent['service_tier'],
): GeminiGenerateContentUsageMetadata | undefined => {
  const usage = chunk.usage;
  if (!usage) return undefined;

  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  const cacheWriteTokens = usage.prompt_tokens_details?.cache_creation_input_tokens
    ?? usage.prompt_tokens_details?.cache_write_tokens;
  // Validated, not consumed: Gemini's `promptTokenCount` carries the same
  // inclusive total and `cachedContentTokenCount` the same subset of it, so
  // there is nothing to recompute. The assertion is this package's own, on the
  // contract its output type declares.
  splitInclusiveInputTokens(usage.prompt_tokens, cachedTokens, cacheWriteTokens);
  const { output: candidatesTokenCount, reasoning: thoughtsTokenCount } = splitInclusiveOutputTokens(
    usage.completion_tokens,
    usage.completion_tokens_details?.reasoning_tokens,
  );
  const serviceTier = billableServiceTier(upstreamServiceTier);

  const metadata: GeminiGenerateContentUsageMetadata = {
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
  }

  return metadata;
};

const UPSTREAM_OPENAI_CHAT_COMPLETIONS_MISSING_DONE_MESSAGE = 'Upstream OpenAI Chat Completions stream ended without a DONE sentinel.';

const upstreamChatCompletionEventsUntilDone = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>): AsyncGenerator<OpenAIChatCompletionsStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') return;
    yield frame.event;
  }

  throw new Error(UPSTREAM_OPENAI_CHAT_COMPLETIONS_MISSING_DONE_MESSAGE);
};

type OpenAIChatCompletionsToolCallDelta = NonNullable<OpenAIChatCompletionsDelta['tool_calls']>[0];

interface OpenAIChatCompletionsToolCallDraft {
  id?: string;
  name?: string;
  argsJson: string;
}

interface OpenAIChatCompletionsToGeminiGenerateContentStreamState extends GeminiGenerateContentThoughtSignatureState {
  toolCalls: Record<number, OpenAIChatCompletionsToolCallDraft>;
}

const getOpenAIChatCompletionsToGeminiGenerateContentStreamState = (states: Record<number, OpenAIChatCompletionsToGeminiGenerateContentStreamState>, index: number): OpenAIChatCompletionsToGeminiGenerateContentStreamState => {
  states[index] ??= { toolCalls: {} };
  return states[index];
};

const accumulateToolCalls = (toolCalls: OpenAIChatCompletionsToolCallDelta[], state: OpenAIChatCompletionsToGeminiGenerateContentStreamState): void => {
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

const flushToolCallParts = (state: OpenAIChatCompletionsToGeminiGenerateContentStreamState): GeminiGenerateContentPart[] => {
  const parts: GeminiGenerateContentPart[] = [];

  for (const [_index, toolCall] of Object.entries(state.toolCalls).sort(([left], [right]) => Number(left) - Number(right))) {
    if (!toolCall.name) continue;

    parts.push(
      signGeminiGenerateContentPart(state, {
        functionCall: {
          ...(toolCall.id !== undefined ? { id: toolCall.id } : {}),
          name: toolCall.name,
          args: toolCall.argsJson ? parseStrictJsonObject(toolCall.argsJson, 'OpenAI Chat Completions tool call arguments') : {},
        },
      }),
    );
  }

  state.toolCalls = {};
  return parts;
};

const buildCandidate = (choice: OpenAIChatCompletionsStreamChoice, state: OpenAIChatCompletionsToGeminiGenerateContentStreamState): GeminiGenerateContentCandidate | null => {
  const parts: GeminiGenerateContentPart[] = [];
  const { delta } = choice;

  if (typeof delta.reasoning_text === 'string') {
    parts.push({ text: delta.reasoning_text, thought: true });
  }

  if (typeof delta.reasoning_opaque === 'string') {
    setGeminiGenerateContentThoughtSignature(state, delta.reasoning_opaque);
  }

  if (typeof delta.content === 'string') {
    parts.push(signGeminiGenerateContentPart(state, { text: delta.content }));
  }

  if (delta.tool_calls) accumulateToolCalls(delta.tool_calls, state);

  const finishReason = mapFinishReason(choice.finish_reason);
  if (finishReason) {
    parts.push(...flushToolCallParts(state));
    parts.push(...flushGeminiGenerateContentThoughtSignature(state));
  }

  if (!parts.length && !finishReason) return null;

  return {
    index: choice.index,
    content: { role: 'model', parts },
    ...(finishReason !== undefined ? { finishReason } : {}),
  };
};

const translateChunk = (
  chunk: OpenAIChatCompletionsStreamEvent,
  states: Record<number, OpenAIChatCompletionsToGeminiGenerateContentStreamState>,
  upstreamServiceTier: OpenAIChatCompletionsStreamEvent['service_tier'],
): GeminiGenerateContentResult | null => {
  const candidates: GeminiGenerateContentCandidate[] = [];

  for (const choice of chunk.choices) {
    const candidate = buildCandidate(choice, getOpenAIChatCompletionsToGeminiGenerateContentStreamState(states, choice.index));

    if (candidate) candidates.push(candidate);
  }

  const usageMetadata = mapUsage(chunk, upstreamServiceTier);

  if (!candidates.length && !usageMetadata) return null;

  return {
    ...(candidates.length ? { candidates } : {}),
    ...(usageMetadata ? { usageMetadata } : {}),
  };
};

const throwOnOpenAIChatCompletionsErrorPayload = (chunk: OpenAIChatCompletionsStreamEvent): void => {
  const message = openaiChatCompletionsErrorPayloadMessage(chunk);
  if (!message) return;

  throw new Error(`Upstream OpenAI Chat Completions stream error: ${message}`, {
    cause: chunk,
  });
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> {
  const states: Record<number, OpenAIChatCompletionsToGeminiGenerateContentStreamState> = {};
  let pendingUsageMetadata: GeminiGenerateContentUsageMetadata | undefined;
  let upstreamServiceTier: OpenAIChatCompletionsStreamEvent['service_tier'];
  const deferredFinalCandidates: GeminiGenerateContentCandidate[] = [];

  for await (const chunk of upstreamChatCompletionEventsUntilDone(frames)) {
    throwOnOpenAIChatCompletionsErrorPayload(chunk);
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
