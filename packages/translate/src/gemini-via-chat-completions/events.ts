import { appendGeminiThoughtSignature, flushGeminiThoughtSignature, type GeminiThoughtSignatureState, parseStrictJsonObject, signGeminiPart } from '../shared/gemini-via/gemini.ts';
import { chatCompletionsErrorPayloadMessage } from '@floway-dev/protocols/chat-completions';
import type { ChatCompletionChunk, Delta } from '@floway-dev/protocols/chat-completions';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiCandidate, GeminiFinishReason, GeminiGenerateContentResponse, GeminiPart, GeminiStreamEvent, GeminiUsageMetadata } from '@floway-dev/protocols/gemini';

type ChatStreamChoice = ChatCompletionChunk['choices'][0];

const mapFinishReason = (finishReason: ChatStreamChoice['finish_reason']): GeminiFinishReason | undefined => {
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

const reasoningTokensFromUsage = (usage: NonNullable<ChatCompletionChunk['usage']>): number | undefined => {
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;

  return typeof reasoningTokens === 'number' ? reasoningTokens : undefined;
};

// OpenAI prompt_tokens already includes prompt_tokens_details.cached_tokens,
// matching Gemini's inclusive promptTokenCount semantics. Pass both through
// directly — no folding. Contrast with gemini-via-messages, where Anthropic's
// input_tokens excludes cache buckets and must be summed.
const mapUsage = (usage?: ChatCompletionChunk['usage']): GeminiUsageMetadata | undefined => {
  if (!usage) return undefined;

  const metadata: GeminiUsageMetadata = {
    promptTokenCount: usage.prompt_tokens,
    candidatesTokenCount: usage.completion_tokens,
    totalTokenCount: usage.total_tokens,
  };

  const thoughtsTokenCount = reasoningTokensFromUsage(usage);
  if (thoughtsTokenCount !== undefined) {
    metadata.thoughtsTokenCount = thoughtsTokenCount;
  }

  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  if (cachedTokens !== undefined) {
    metadata.cachedContentTokenCount = cachedTokens;
  }

  return metadata;
};

const UPSTREAM_CHAT_COMPLETIONS_MISSING_DONE_MESSAGE = 'Upstream Chat Completions stream ended without a DONE sentinel.';

const upstreamChatCompletionEventsUntilDone = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>): AsyncGenerator<ChatCompletionChunk> {
  for await (const frame of frames) {
    if (frame.type === 'done') return;
    yield frame.event;
  }

  throw new Error(UPSTREAM_CHAT_COMPLETIONS_MISSING_DONE_MESSAGE);
};

type ChatToolCallDelta = NonNullable<Delta['tool_calls']>[0];

interface ChatToolCallDraft {
  id?: string;
  name?: string;
  argsJson: string;
}

interface ChoiceState extends GeminiThoughtSignatureState {
  toolCalls: Record<number, ChatToolCallDraft>;
}

const getChoiceState = (states: Record<number, ChoiceState>, index: number): ChoiceState => {
  states[index] ??= { toolCalls: {} };
  return states[index];
};

const accumulateToolCalls = (toolCalls: ChatToolCallDelta[], state: ChoiceState): void => {
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

const flushToolCallParts = (state: ChoiceState): GeminiPart[] => {
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

const buildCandidate = (choice: ChatStreamChoice, state: ChoiceState): GeminiCandidate | null => {
  const parts: GeminiPart[] = [];
  const { delta } = choice;

  if (typeof delta.reasoning_text === 'string') {
    parts.push({ text: delta.reasoning_text, thought: true });
  }

  if (typeof delta.reasoning_opaque === 'string') {
    appendGeminiThoughtSignature(state, delta.reasoning_opaque);
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

const translateChunk = (chunk: ChatCompletionChunk, states: Record<number, ChoiceState>): GeminiGenerateContentResponse | null => {
  const candidates: GeminiCandidate[] = [];

  for (const choice of chunk.choices) {
    const candidate = buildCandidate(choice, getChoiceState(states, choice.index));

    if (candidate) candidates.push(candidate);
  }

  const usageMetadata = mapUsage(chunk.usage);

  if (!candidates.length && !usageMetadata) return null;

  return {
    ...(candidates.length ? { candidates } : {}),
    ...(usageMetadata ? { usageMetadata } : {}),
  };
};

const throwOnChatErrorPayload = (chunk: ChatCompletionChunk): void => {
  const message = chatCompletionsErrorPayloadMessage(chunk);
  if (!message) return;

  throw new Error(`Upstream Chat Completions stream error: ${message}`, {
    cause: chunk,
  });
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
  const states: Record<number, ChoiceState> = {};
  let pendingUsageMetadata: GeminiUsageMetadata | undefined;
  const deferredFinalCandidates: GeminiCandidate[] = [];

  for await (const chunk of upstreamChatCompletionEventsUntilDone(frames)) {
    throwOnChatErrorPayload(chunk);

    const response = translateChunk(chunk, states);
    if (!response) continue;

    if (response.usageMetadata) {
      pendingUsageMetadata = response.usageMetadata;
    }

    const candidates = response.candidates ?? [];
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
