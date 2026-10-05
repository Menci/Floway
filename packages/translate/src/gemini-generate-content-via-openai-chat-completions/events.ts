import { parseStrictJsonObject } from '../shared/gemini-generate-content-via/gemini-generate-content.ts';
import { createChatStreamLifecycle } from '../shared/openai-chat-completions/lifecycle.ts';
import { eventFrame, splitInclusiveInputTokens, splitInclusiveOutputTokens, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentCandidate, GeminiGenerateContentFinishReason, GeminiGenerateContentPart, GeminiGenerateContentStreamEvent, GeminiGenerateContentUsageMetadata } from '@floway-dev/protocols/gemini-generate-content';
import { OpenAIChatCompletionsAssistantMessagePrivate, accumulateOpenAIChatCompletionsPrivate, finalizeOpenAIChatCompletionsPrivate, type OpenAIChatCompletionsPrivateDraft, type OpenAIChatCompletionsAssistantDelta, type OpenAIChatCompletionsUsageEx, openaiChatCompletionsErrorPayloadMessage, type OpenAIChatCompletionsPrivateContext, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

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
// matching Gemini generateContent's inclusive promptTokenCount semantics. Pass both through
// directly — no folding. Contrast with gemini-generate-content-via-anthropic-messages, where Anthropic's
// input_tokens excludes cache buckets and must be summed.
const mapUsage = (
  chunk: OpenAIChatCompletionsStreamEvent,
): GeminiGenerateContentUsageMetadata | undefined => {
  const usage = chunk.usage;
  if (!usage) return undefined;

  const cachedTokens = (usage as OpenAIChatCompletionsUsageEx).prompt_tokens_details?.cached_tokens;
  const cacheWriteTokens = (usage as OpenAIChatCompletionsUsageEx).prompt_tokens_details?.cache_creation_input_tokens
    ?? (usage as OpenAIChatCompletionsUsageEx).prompt_tokens_details?.cache_write_tokens;
  // Validated, not consumed: Gemini generateContent's `promptTokenCount` carries the same
  // inclusive total and `cachedContentTokenCount` the same subset of it, so
  // there is nothing to recompute. The assertion is this package's own, on the
  // contract its output type declares.
  splitInclusiveInputTokens(usage.prompt_tokens, cachedTokens, cacheWriteTokens);
  const { output: candidatesTokenCount, reasoning: thoughtsTokenCount } = splitInclusiveOutputTokens(
    usage.completion_tokens,
    usage.completion_tokens_details?.reasoning_tokens,
  );

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

  return metadata;
};

interface ToolDraft { id: string; name: string; arguments: string }
interface CandidateState {
  lifecycle: ReturnType<typeof createChatStreamLifecycle>;
  tools: Map<number, ToolDraft>;
  privateState: OpenAIChatCompletionsPrivateDraft;
  finishReason?: GeminiGenerateContentFinishReason;
}

const toolParts = (state: CandidateState, changes: ReturnType<CandidateState['lifecycle']['accept']>): GeminiGenerateContentPart[] => {
  const parts: GeminiGenerateContentPart[] = [];
  for (const change of changes) {
    if (change.type === 'open') state.tools.set(change.slot.index, { id: change.id!, name: change.name!, arguments: '' });
    else if (change.type === 'delta') state.tools.get(change.slot.index)!.arguments += change.text;
    else {
      const tool = state.tools.get(change.slot.index)!;
      parts.push({ functionCall: { id: tool.id, name: tool.name, args: parseStrictJsonObject(tool.arguments, 'OpenAI Chat Completions tool call arguments') } });
      state.tools.delete(change.slot.index);
    }
  }
  return parts;
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>, context: OpenAIChatCompletionsPrivateContext): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> {
  const states = new Map<number, CandidateState>();
  let usageMetadata: GeminiGenerateContentUsageMetadata | undefined;
  for await (const frame of frames) {
    if (frame.type === 'done') break;
    const chunk = frame.event;
    const error = openaiChatCompletionsErrorPayloadMessage(chunk);
    if (error) throw new Error(`Upstream OpenAI Chat Completions stream error: ${error}`, { cause: chunk });
    const usage = mapUsage(chunk);
    if (usage !== undefined) usageMetadata = usage;
    const candidates: GeminiGenerateContentCandidate[] = [];
    for (const choice of chunk.choices) {
      const state: CandidateState = states.get(choice.index) ?? { lifecycle: createChatStreamLifecycle(index => console.warn(`Ignoring data for closed Chat tool call ${index}`)), tools: new Map<number, ToolDraft>(), privateState: {} };
      states.set(choice.index, state);
      const parts: GeminiGenerateContentPart[] = [];
      const { delta } = choice;
      const privateDelta = (delta as OpenAIChatCompletionsAssistantDelta)[OpenAIChatCompletionsAssistantMessagePrivate];
      if (privateDelta !== undefined) {
        accumulateOpenAIChatCompletionsPrivate(state.privateState, privateDelta);
        if (privateDelta.reasoningText !== undefined) parts.push({ thought: true, text: privateDelta.reasoningText });
      }
      if (typeof delta.content === 'string') parts.push({ text: delta.content });
      parts.push(...toolParts(state, state.lifecycle.accept((delta.tool_calls ?? []).map(call => ({ kind: 'tool', index: call.index, id: call.id, name: call.function?.name, arguments: call.function?.arguments })))));
      const finishReason = mapFinishReason(choice.finish_reason);
      if (finishReason !== undefined) state.finishReason = finishReason;
      if (parts.length > 0) candidates.push({ index: choice.index, content: { role: 'model', parts } });
    }
    if (candidates.length > 0) yield eventFrame({ candidates });
  }
  const candidates: GeminiGenerateContentCandidate[] = [];
  for (const [index, state] of states) {
    const parts = toolParts(state, state.lifecycle.finish());
    const privateState = finalizeOpenAIChatCompletionsPrivate(state.privateState) ?? { sidecar: { upstreamProtocol: 'openaiChatCompletions' } };
    parts.push({ thoughtSignature: await context.codec.encapsulate(privateState) });
    candidates.push({ index, content: { role: 'model', parts }, finishReason: state.finishReason ?? 'STOP' });
  }
  if (candidates.length > 0 || usageMetadata !== undefined) yield eventFrame({ ...(candidates.length > 0 ? { candidates } : {}), ...(usageMetadata !== undefined ? { usageMetadata } : {}) });
};
