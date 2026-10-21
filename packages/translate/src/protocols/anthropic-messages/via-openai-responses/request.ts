import { klona } from 'klona/json';

import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiResponsesFromIR } from '../../openai-responses/as-target/input-from.ts';
import { filterAnthropicMessagesClientTools } from '../as-source/client-tools.ts';
import { partitionAnthropicMessagesTurns } from '../as-source/conversation-turns.ts';
import { anthropicMessagesDropsReasoning, anthropicMessagesTurnToIR } from '../as-source/input-to.ts';
import { collectAnthropicMessagesReplayContents, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest } from '../as-source/round-trip.ts';
import type {
  AnthropicMessagesClientTool,
  AnthropicMessagesMetadataEx,
  AnthropicMessagesPayload,
  AnthropicMessagesTextBlockParam,
} from '@floway-dev/protocols/anthropic-messages';
import { FAST_SERVICE_TIER } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, CanonicalOpenAIResponsesInputItem, OpenAIResponsesTool, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';

// OpenAI strict-mode JSON Schema validators reject an object schema without an
// explicit `properties` field. Preserve the source schema while satisfying that
// target requirement.
// https://github.com/caozhiyuan/copilot-api/commit/ad57069826843c5d17d7b0e5ef2f75050128893c
const normalizeToolInputSchema = (schema: Record<string, unknown>): Record<string, unknown> => {
  const target = klona(schema);
  if (target.type !== 'object' || target.properties !== undefined) return target;
  return { ...target, properties: {} };
};

// The Responses effort axis combines Anthropic's separate effort and thinking
// controls; token budgets remain a separate quantity.
const resolveReasoningEffort = (payload: AnthropicMessagesPayload): string | undefined => {
  if (payload.output_config?.effort != null) return payload.output_config.effort;
  if (payload.thinking?.type === 'disabled') return 'none';
  if (payload.thinking?.type === 'enabled' || payload.thinking?.type === 'adaptive') return 'medium';
  return undefined;
};

// Preserve per-block boundaries when the source carries a
// AnthropicMessagesTextBlockParam[]; single-string source stays as string content.
// OpenAI Responses' `instructions` field is `string | null` — it cannot carry
// multiple text blocks faithfully. When the source `AnthropicMessagesPayload.system`
// is a single string or a single block, the canonical `instructions` slot
// is the right home. When the source is a multi-block array, the canonical
// slot would silently merge the boundaries, so emit a leading input
// system message with multi-part `input_text` content instead and leave
// `instructions` null; both placements act as a system prompt prefix at
// the upstream and the multi-part form preserves the caller-visible block
// structure.
interface SystemPlacement {
  readonly instructions: string | null;
  readonly prependItems: readonly CanonicalOpenAIResponsesInputItem[];
}

const placeAnthropicMessagesSystem = (system: string | AnthropicMessagesTextBlockParam[] | undefined): SystemPlacement => {
  if (typeof system === 'string') return { instructions: system, prependItems: [] };
  if (!system || system.length === 0) return { instructions: null, prependItems: [] };
  if (system.length === 1) return { instructions: system[0].text, prependItems: [] };
  return {
    instructions: null,
    prependItems: [{
      type: 'message',
      role: 'system',
      content: system.map(block => ({ type: 'input_text', text: block.text })),
    }],
  };
};

const translateTools = (tools: AnthropicMessagesClientTool[] | undefined): OpenAIResponsesTool[] => {
  if (!tools || tools.length === 0) return [];

  return tools.map(tool => ({
    type: 'function',
    name: tool.name,
    parameters: normalizeToolInputSchema(tool.input_schema),
    // OpenAI Responses tools default stricter than Anthropic/OpenAI-Chat-Completions-style function tools,
    // so omitted source strictness is made explicit as false.
    strict: tool.strict ?? false,
    ...(tool.description ? { description: tool.description } : {}),
  }));
};

// OpenAI Responses upstreams disagree on an orphaned `tool_choice` — one sent without
// tools: OpenAI-backed models ignore it, while xAI-backed ones reject the
// request with `invalid-argument: A tool_choice was set on the request but no
// tools were specified`. Other gateways hit the same wall on both the native
// OpenAI Responses path and the OpenAI Responses → OpenAI Chat Completions path:
// https://github.com/Wei-Shaw/sub2api/issues/4819
// https://github.com/jlcodes99/cockpit-tools/issues/1727
const translateToolChoice = (toolChoice: AnthropicMessagesPayload['tool_choice'], tools?: AnthropicMessagesClientTool[]): OpenAIResponsesToolChoice | undefined => {
  if (!toolChoice) return undefined;
  if (!tools || tools.length === 0) {
    if (toolChoice.type === 'tool') throw new TranslatorInputError(`Anthropic Messages tool_choice names an undeclared tool: ${String(toolChoice.name)}`);
    return undefined;
  }

  const toolNames = new Set(tools.map(tool => tool.name));

  switch (toolChoice.type) {
  case 'auto':
    return 'auto';
  case 'any':
    return 'required';
  case 'tool': {
    if (!toolChoice.name || !toolNames.has(toolChoice.name)) throw new TranslatorInputError(`Anthropic Messages tool_choice names an undeclared tool: ${String(toolChoice.name)}`);
    return { type: 'function', name: toolChoice.name };
  }
  case 'none':
    return 'none';
  }
};

const translateMetadata = (metadata: AnthropicMessagesMetadataEx): Record<string, string> => Object.fromEntries(Object.entries(metadata).flatMap(([key, value]) => {
  if (key === 'user_id' && value == null) return [];
  if (typeof value !== 'string') throw new TranslatorInputError(`Cannot translate Anthropic Messages metadata field '${key}' to a Responses string metadata value.`);
  return [[key, value]];
}));

export const buildTargetRequest = async (
  payload: AnthropicMessagesPayload,
  codec: SidecarCodec,
): Promise<CanonicalOpenAIResponsesPayload> => {
  // Preserve the source `output_config.effort` value as-is, even if the chosen
  // OpenAI Responses upstream may reject it. Translation stays pairwise and leaves
  // target-side validation to the selected upstream endpoint.
  const effort = resolveReasoningEffort(payload);
  const reasoning = effort !== undefined ? { effort } : undefined;
  const clientTools = filterAnthropicMessagesClientTools(payload.tools);
  const { instructions, prependItems } = placeAnthropicMessagesSystem(payload.system);
  // Anthropic's structured-output schema is already strict. Supply the name
  // required by OpenAI and let OpenAI report any schema constraint it rejects.
  // https://platform.claude.com/docs/en/build-with-claude/structured-outputs
  const format = payload.output_config?.format;
  const jsonSchema = format?.type === 'json_schema'
    ? { name: 'messages_response', strict: true as const, schema: klona(format.schema) }
    : undefined;
  const text = jsonSchema ? { format: { type: 'json_schema' as const, ...jsonSchema } } : undefined;

  // Anthropic `speed: 'fast'` selects OpenAI's priority lane. Without an
  // explicit speed, preserve Anthropic's service tier as an open string.
  // https://docs.claude.com/en/build-with-claude/fast-mode
  // https://platform.openai.com/docs/guides/fast-mode
  const serviceTier = payload.speed === 'fast' ? FAST_SERVICE_TIER : payload.speed === undefined ? payload.service_tier : undefined;
  const toolChoice = translateToolChoice(payload.tool_choice, clientTools);
  // `placeAnthropicMessagesSystem` owns the single-block/multi-block decision:
  // one block fits the string-valued `instructions` slot, several become a
  // leading input message that keeps their boundaries.
  const pieces: (IRInputTurn | IRInputResolvedTurn<CanonicalOpenAIResponsesInputItem[]>)[] = [];
  let messageIndex = 0;
  for (const turn of partitionAnthropicMessagesTurns(payload.messages)) {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('anthropicMessages', 'openaiResponses', turn.items, codec, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest, collectAnthropicMessagesReplayContents);
      if (roundTrip !== undefined) {
        pieces.push({ kind: 'resolved', turn: roundTrip.turn });
        messageIndex += turn.items.length;
        continue;
      }
      if (anthropicMessagesDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('anthropicMessages', 'openaiResponses');
    }
    pieces.push(...anthropicMessagesTurnToIR(turn, messageIndex, ' user content blocks are not supported on this model'));
    messageIndex += turn.items.length;
  }

  const input: CanonicalOpenAIResponsesInputItem[] = [...prependItems];
  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') { input.push(...piece.turn); continue; }
    input.push(...openaiResponsesFromIR({ turns: piece.turns }, false, { compactUserText: true }).input);
  }

  // Keep fallback semantics strict: do not synthesize `temperature: 1`,
  // `store: false`, `parallel_tool_calls: true`, `reasoning.summary`, or
  // `reasoning.context` when the Anthropic Messages source did not express those knobs.
  // The source thinking block carries no reasoning-context mode, so we never
  // invent `all_turns` (or any other value) on the target reasoning object.
  return {
    model: payload.model,
    input,
    ...(instructions !== null ? { instructions } : {}),
    ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    max_output_tokens: payload.max_tokens,
    ...(payload.tools !== undefined ? { tools: translateTools(clientTools) } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(payload.metadata ? { metadata: translateMetadata(payload.metadata as AnthropicMessagesMetadataEx) } : {}),
    stream: true,
    ...(reasoning ? { reasoning } : {}),
    ...(text ? { text } : {}),
    ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
  };
};
