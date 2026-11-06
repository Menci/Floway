import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputRequest, IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiChatCompletionsRequestFromIR } from '../../openai-chat-completions/as-target/input-from.ts';
import { partitionAnthropicMessagesTurns } from '../as-source/conversation-turns.ts';
import { anthropicMessagesDropsReasoning, anthropicMessagesSettingsToIR, anthropicMessagesToolsToIR, anthropicMessagesTurnToIR } from '../as-source/input-to.ts';
import { collectAnthropicMessagesReplayContents, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest } from '../as-source/round-trip.ts';
import type {
  AnthropicMessagesPayload,
  AnthropicMessagesTextBlockParam,
} from '@floway-dev/protocols/anthropic-messages';
import { FAST_SERVICE_TIER } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamOptionsEx, OpenAIChatCompletionsTextPart, OpenAIChatCompletionsPayload, OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';

// OpenAI strict-mode JSON Schema validators reject an object schema without an
// explicit `properties` field. Preserve the source schema while satisfying that
// target requirement.
// https://github.com/caozhiyuan/copilot-api/commit/ad57069826843c5d17d7b0e5ef2f75050128893c
// The Chat Completions effort axis combines Anthropic's separate effort and
// thinking controls; token budgets remain a separate quantity.
const resolveReasoningEffort = (payload: AnthropicMessagesPayload): string | undefined => {
  if (payload.output_config?.effort != null) return payload.output_config.effort;
  if (payload.thinking?.type === 'disabled') return 'none';
  if (payload.thinking?.type === 'enabled' || payload.thinking?.type === 'adaptive') return 'medium';
  return undefined;
};

// Anthropic Messages system blocks are prompt boundaries; preserve each one
// as a separate OpenAI Chat Completions text part so a CC→Anthropic Messages→CC round trip
// does not silently merge them. Falls back to the simple string form when
// the source is already a single-string field.
const systemContentFromBlocks = (system: string | AnthropicMessagesTextBlockParam[]): string | OpenAIChatCompletionsTextPart[] =>
  typeof system === 'string'
    ? system
    : system.map(block => ({ type: 'text', text: block.text }));

export const buildTargetRequest = async (
  payload: AnthropicMessagesPayload,
  codec: SidecarCodec,
): Promise<OpenAIChatCompletionsPayload> => {
  // Pass effort through verbatim; per-upstream enum acceptance (e.g. some
  // backends rejecting `xhigh`/`max`) is the target interceptor's concern.
  const reasoningEffort = resolveReasoningEffort(payload);
  const ir: IRInputRequest = {
    conversation: { turns: [] },
    settings: {
      ...anthropicMessagesSettingsToIR(payload),
      // Anthropic `speed: 'fast'` selects OpenAI's priority lane. Without an
      // explicit speed, preserve Anthropic's service tier as an open string.
      // https://docs.claude.com/en/build-with-claude/fast-mode
      // https://platform.openai.com/docs/guides/fast-mode
      ...(payload.speed === 'fast' ? { service_tier: FAST_SERVICE_TIER } : {}),
      ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    },
    ...anthropicMessagesToolsToIR(payload),
  };
  const messages: OpenAIChatCompletionsMessage[] = payload.system == null || (typeof payload.system === 'string' ? payload.system === '' : payload.system.length === 0)
    ? []
    : [{ role: 'system', content: systemContentFromBlocks(payload.system) }];
  const pieces: (IRInputTurn | IRInputResolvedTurn<OpenAIChatCompletionsMessage>)[] = [];
  let messageIndex = 0;
  for (const turn of partitionAnthropicMessagesTurns(payload.messages)) {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('anthropicMessages', 'openaiChatCompletions', turn.items, codec, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest, collectAnthropicMessagesReplayContents);
      if (roundTrip !== undefined) {
        pieces.push({ kind: 'resolved', turn: roundTrip.turn });
        messageIndex += turn.items.length;
        continue;
      }
      if (anthropicMessagesDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('anthropicMessages', 'openaiChatCompletions');
    }
    pieces.push(...anthropicMessagesTurnToIR(turn, messageIndex));
    messageIndex += turn.items.length;
  }

  let base: OpenAIChatCompletionsPayload | undefined;
  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') { messages.push(piece.turn); continue; }
    const translated = openaiChatCompletionsRequestFromIR({ ...ir, conversation: { turns: piece.turns } });
    base ??= translated;
    messages.push(...translated.messages);
  }
  base ??= openaiChatCompletionsRequestFromIR({ ...ir, conversation: { turns: [] } });

  return {
    ...base,
    messages,
    // Ask the upstream for usage on every streaming chunk, not just the final
    // one. `include_usage` is the OpenAI-standard flag; `continuous_usage_stats`
    // is the vLLM/SGLang extension that lets this translation emit the real
    // `input_tokens` in `message_start` (before any output exists) and
    // cumulative `output_tokens` on intermediate `message_delta` events, which
    // is the shape the Anthropic Messages SSE contract promises. Upstreams that
    // do not implement the extension ignore it, and the translator falls back
    // to the final usage-only chunk. Ref:
    // https://github.com/vllm-project/vllm/blob/d5f0a6e829faa69d1db289bf62b14dae136c02b2/vllm/entrypoints/generate/base/protocol.py#L241-L243
    stream_options: { include_usage: true, continuous_usage_stats: true } as OpenAIChatCompletionsStreamOptionsEx,
  };
};
