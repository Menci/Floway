import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputRequest, IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiResponsesRequestFromIR } from '../../openai-responses/as-target/input-from.ts';
import { partitionAnthropicMessagesTurns } from '../as-source/conversation-turns.ts';
import { anthropicMessagesDropsReasoning, anthropicMessagesSettingsToIR, anthropicMessagesToolsToIR, anthropicMessagesTurnToIR } from '../as-source/input-to.ts';
import { collectAnthropicMessagesReplayContents, findAnthropicMessagesSidecarCarriers, verifyAnthropicMessagesTurnDigest } from '../as-source/round-trip.ts';
import type {
  AnthropicMessagesMetadataEx,
  AnthropicMessagesPayload,
  AnthropicMessagesTextBlockParam,
} from '@floway-dev/protocols/anthropic-messages';
import { FAST_SERVICE_TIER } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

// OpenAI strict-mode JSON Schema validators reject an object schema without an
// explicit `properties` field. Preserve the source schema while satisfying that
// target requirement.
// https://github.com/caozhiyuan/copilot-api/commit/ad57069826843c5d17d7b0e5ef2f75050128893c
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

// Responses metadata values are strings; a Messages caller may attach anything,
// so a value that cannot be stated as one is a caller error rather than a
// silent drop.
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
  const { instructions, prependItems } = placeAnthropicMessagesSystem(payload.system);
  const ir: IRInputRequest = {
    conversation: { turns: [] },
    settings: {
      ...anthropicMessagesSettingsToIR(payload),
      // Anthropic `speed: 'fast'` selects OpenAI's priority lane. Without an
      // explicit speed, preserve Anthropic's service tier as an open string.
      // https://docs.claude.com/en/build-with-claude/fast-mode
      // https://platform.openai.com/docs/guides/fast-mode
      ...(payload.speed === 'fast' ? { service_tier: FAST_SERVICE_TIER } : {}),
      ...(effort === undefined ? {} : { reasoning_effort: effort }),
      ...(payload.metadata === undefined ? {} : { metadata: translateMetadata(payload.metadata as AnthropicMessagesMetadataEx) }),
    },
    ...anthropicMessagesToolsToIR(payload),
  };

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
  let base: CanonicalOpenAIResponsesPayload | undefined;
  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') { input.push(...piece.turn); continue; }
    const translated = openaiResponsesRequestFromIR({ ...ir, conversation: { turns: piece.turns } }, false);
    base ??= translated;
    input.push(...translated.input);
  }
  base ??= openaiResponsesRequestFromIR({ ...ir, conversation: { turns: [] } }, false);

  // Keep fallback semantics strict: do not synthesize `temperature: 1`,
  // `store: false`, `parallel_tool_calls: true`, `reasoning.summary`, or
  // `reasoning.context` when the Messages source did not express those knobs.
  return {
    ...base,
    input,
    ...(instructions !== null ? { instructions } : {}),
  };
};
