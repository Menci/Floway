import { klona } from 'klona/json';

import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input-segments.ts';
import type { IRInputTurn } from '../../../ir/input.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiChatCompletionsFromIR } from '../../openai-chat-completions/as-target/request-from-ir.ts';
import { filterAnthropicMessagesClientTools } from '../as-source/client-tools.ts';
import { partitionAnthropicMessagesTurns } from '../as-source/conversation-turns.ts';
import { anthropicMessagesDropsReasoning, anthropicMessagesTurnToIR } from '../as-source/request-to-ir.ts';
import { collectAnthropicMessagesReplayContents, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest } from '../as-source/round-trip.ts';
import type {
  AnthropicMessagesClientTool,
  AnthropicMessagesPayload,
  AnthropicMessagesTextBlockParam,
} from '@floway-dev/protocols/anthropic-messages';
import { FAST_SERVICE_TIER } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsStreamOptionsEx, OpenAIChatCompletionsTextPart, OpenAIChatCompletionsPayload, OpenAIChatCompletionsMessage, OpenAIChatCompletionsTool } from '@floway-dev/protocols/openai-chat-completions';

// OpenAI strict-mode JSON Schema validators reject an object schema without an
// explicit `properties` field. Preserve the source schema while satisfying that
// target requirement.
// https://github.com/caozhiyuan/copilot-api/commit/ad57069826843c5d17d7b0e5ef2f75050128893c
const normalizeToolInputSchema = (schema: Record<string, unknown>): Record<string, unknown> => {
  const target = klona(schema);
  if (target.type !== 'object' || target.properties !== undefined) return target;
  return { ...target, properties: {} };
};

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

const translateAnthropicMessagesTools = (tools?: AnthropicMessagesClientTool[]): OpenAIChatCompletionsTool[] | undefined =>
  // Do not hide target-side function-name constraints by renaming tools here;
  // the Anthropic Messages source contract has no reverse mapping surface for that.
  tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeToolInputSchema(tool.input_schema),
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    },
  }));

const translateAnthropicMessagesToolChoice = (toolChoice?: AnthropicMessagesPayload['tool_choice'], tools?: AnthropicMessagesClientTool[]): OpenAIChatCompletionsPayload['tool_choice'] => {
  if (!toolChoice) return undefined;
  if (!tools || tools.length === 0) {
    if (toolChoice.type === 'tool') throw new TranslatorInputError(`Anthropic Messages tool_choice names an undeclared tool: ${String(toolChoice.name)}`);
    return undefined;
  }

  switch (toolChoice.type) {
  case 'auto':
    return 'auto';
  case 'any':
    return 'required';
  case 'tool': {
    if (!toolChoice.name || !tools.some(tool => tool.name === toolChoice.name)) throw new TranslatorInputError(`Anthropic Messages tool_choice names an undeclared tool: ${String(toolChoice.name)}`);
    return { type: 'function', function: { name: toolChoice.name } };
  }
  case 'none':
    return 'none';
  }
};

export const buildTargetRequest = async (
  payload: AnthropicMessagesPayload,
  codec: SidecarCodec,
): Promise<OpenAIChatCompletionsPayload> => {
  const clientTools = filterAnthropicMessagesClientTools(payload.tools);
  const legacyFunctionNames = new Map<string, string>();
  // Pass effort through verbatim; per-upstream enum acceptance (e.g. some
  // backends rejecting `xhigh`/`max`) is the target interceptor's concern.
  const reasoningEffort = resolveReasoningEffort(payload);
  // Anthropic's structured-output schema is already strict. Supply the name
  // required by OpenAI and let OpenAI report any schema constraint it rejects.
  // https://platform.claude.com/docs/en/build-with-claude/structured-outputs
  const format = payload.output_config?.format;
  const jsonSchema = format?.type === 'json_schema'
    ? { name: 'messages_response', strict: true as const, schema: klona(format.schema) }
    : undefined;
  const responseFormat = jsonSchema ? { type: 'json_schema' as const, json_schema: jsonSchema } : undefined;

  // Anthropic `speed: 'fast'` selects OpenAI's priority lane. Without an
  // explicit speed, preserve Anthropic's service tier as an open string.
  // https://docs.claude.com/en/build-with-claude/fast-mode
  // https://platform.openai.com/docs/guides/fast-mode
  const serviceTier = payload.speed === 'fast' ? FAST_SERVICE_TIER : payload.speed === undefined ? payload.service_tier : undefined;
  const messages: OpenAIChatCompletionsMessage[] = payload.system == null || (typeof payload.system === 'string' ? payload.system === '' : payload.system.length === 0)
    ? []
    : [{ role: 'system', content: systemContentFromBlocks(payload.system) }];
  const pieces: (IRInputTurn | IRInputResolvedTurn<OpenAIChatCompletionsMessage>)[] = [];
  let messageIndex = 0;
  for (const turn of partitionAnthropicMessagesTurns(payload.messages)) {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('anthropicMessages', 'openaiChatCompletions', turn.items, codec, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest, collectAnthropicMessagesReplayContents);
      if (roundTrip !== undefined) {
        if (roundTrip.turn.function_call != null) {
          const modernIds = new Set(roundTrip.turn.tool_calls?.map(call => call.id));
          for (const message of turn.items) if (Array.isArray(message.content)) for (const block of message.content) {
            if ((block.type === 'tool_use' || block.type === 'server_tool_use') && !modernIds.has(block.id)) legacyFunctionNames.set(block.id, roundTrip.turn.function_call.name);
          }
        }
        pieces.push({ kind: 'resolved', turn: roundTrip.turn });
        messageIndex += turn.items.length;
        continue;
      }
      if (anthropicMessagesDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('anthropicMessages', 'openaiChatCompletions');
    }
    pieces.push(...anthropicMessagesTurnToIR(turn, messageIndex));
    messageIndex += turn.items.length;
  }

  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') { messages.push(piece.turn); continue; }
    messages.push(...openaiChatCompletionsFromIR({ turns: piece.turns }, { legacyFunctionNames }));
  }

  return {
    model: payload.model,
    messages,
    ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
    max_tokens: payload.max_tokens,
    stop: klona(payload.stop_sequences),
    stream: true,
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
    temperature: payload.temperature,
    top_p: payload.top_p,
    tools: translateAnthropicMessagesTools(clientTools),
    tool_choice: translateAnthropicMessagesToolChoice(payload.tool_choice, clientTools),
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
  };
};
