import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { applyLastMessageCacheBreakpoint, applyLastSystemCacheBreakpoint, applyLastToolCacheBreakpoint } from '../../anthropic-messages/as-target/cache-breakpoints.ts';
import { anthropicMessagesRequestFromIR } from '../../anthropic-messages/as-target/input-from.ts';
import { geminiGenerateContentText } from '../as-source/content.ts';
import { partitionGeminiGenerateContentTurns } from '../as-source/conversation-turns.ts';
import { geminiGenerateContentContentsToIRTurns, geminiGenerateContentDropsReasoning, geminiGenerateContentRequestToIR } from '../as-source/input-to.ts';
import { collectGeminiGenerateContentReplayContents, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest } from '../as-source/round-trip.ts';
import type { GeminiGenerateContentToolCallIds } from '../as-source/tools.ts';
import {
  type AnthropicMessagesPayload,
  type AnthropicMessagesTextBlockParam,
} from '@floway-dev/protocols/anthropic-messages';
import type { GeminiGenerateContentPayload, GeminiGenerateContentThinkingConfig } from '@floway-dev/protocols/gemini-generate-content';

interface ThinkingConfigFields {
  thinking?: NonNullable<AnthropicMessagesPayload['thinking']>;
  outputConfig: NonNullable<AnthropicMessagesPayload['output_config']>;
}

const applyThinkingConfig = (thinkingConfig?: GeminiGenerateContentThinkingConfig): ThinkingConfigFields => {
  if (!thinkingConfig) return { outputConfig: {} };

  let thinking: ThinkingConfigFields['thinking'];
  if (thinkingConfig.thinkingBudget === -1) {
    thinking = { type: 'adaptive' };
  } else if (thinkingConfig.thinkingBudget !== undefined && thinkingConfig.thinkingBudget > 0) {
    thinking = {
      type: 'enabled',
      budget_tokens: thinkingConfig.thinkingBudget,
    };
  } else if (thinkingConfig.thinkingBudget === 0) {
    thinking = { type: 'disabled' };
  }

  const effort = thinkingConfig?.thinkingLevel;
  return {
    ...(thinking !== undefined ? { thinking } : {}),
    outputConfig: effort !== undefined ? { effort } : {},
  };
};

export const buildTargetRequest = async (
  payload: GeminiGenerateContentPayload,
  model: string,
  codec: SidecarCodec,
  options: { fallbackMaxOutputTokens: number | undefined },
): Promise<AnthropicMessagesPayload> => {
  const unmatchedToolCallIds: GeminiGenerateContentToolCallIds = Object.create(null);

  const restoredMessages = new Set<AnthropicMessagesPayload['messages'][number]>();
  let contentIndex = 0;
  const pieces: (IRInputTurn | IRInputResolvedTurn<AnthropicMessagesPayload['messages'][number]>)[] = [];
  for (const turn of partitionGeminiGenerateContentTurns(payload.contents ?? [])) {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('geminiGenerateContent', 'anthropicMessages', turn.items, codec, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest, collectGeminiGenerateContentReplayContents);
      if (roundTrip !== undefined) {
        pieces.push({ kind: 'resolved', turn: roundTrip.turn });
        restoredMessages.add(roundTrip.turn);
        if (Array.isArray(roundTrip.turn.content)) for (const block of roundTrip.turn.content) {
          if (block.type !== 'tool_use' && block.type !== 'server_tool_use') continue;
          unmatchedToolCallIds[block.name] ??= [];
          unmatchedToolCallIds[block.name].push(block.id);
        }
        contentIndex += turn.items.length;
        continue;
      }
      if (geminiGenerateContentDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('geminiGenerateContent', 'anthropicMessages');
    }
    pieces.push(...geminiGenerateContentContentsToIRTurns(turn, contentIndex, unmatchedToolCallIds));
    contentIndex += turn.items.length;
  }

  const ir = geminiGenerateContentRequestToIR(payload, model);
  // A GenerateContent system instruction is the conversation model's leading
  // turn; the pieces above were built from `contents` alone, so it joins them
  // here and each writer hoists it.
  if (geminiGenerateContentText(payload.systemInstruction) !== null) {
    const leading = ir.conversation.turns[0];
    if (leading !== undefined) pieces.unshift(leading);
  }
  const messages: AnthropicMessagesPayload['messages'] = [];
  const systemBlocks: AnthropicMessagesTextBlockParam[] = [];
  let base: AnthropicMessagesPayload | undefined;
  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') { messages.push(piece.turn); continue; }
    const translated = await anthropicMessagesRequestFromIR(
      { ...ir, conversation: { turns: piece.turns } },
      { fallbackMaxOutputTokens: options.fallbackMaxOutputTokens },
    );
    base ??= translated;
    if (translated.system !== undefined) systemBlocks.push(...(typeof translated.system === 'string' ? [{ type: 'text' as const, text: translated.system }] : translated.system));
    messages.push(...translated.messages);
  }
  base ??= await anthropicMessagesRequestFromIR({ ...ir, conversation: { turns: [] } }, { fallbackMaxOutputTokens: options.fallbackMaxOutputTokens });

  const request: AnthropicMessagesPayload = {
    ...base,
    messages,
    ...(systemBlocks.length === 0 ? {} : { system: systemBlocks }),
  };

  const { thinking, outputConfig: thinkingOutputConfig } = applyThinkingConfig(payload.generationConfig?.thinkingConfig);
  if (thinking !== undefined) request.thinking = thinking;
  const outputConfig = { ...(request.output_config ?? {}), ...thinkingOutputConfig };
  if (Object.keys(outputConfig).length > 0) request.output_config = outputConfig;

  if (systemBlocks.length > 0) applyLastSystemCacheBreakpoint(systemBlocks);
  applyLastToolCacheBreakpoint(request.tools);
  applyLastMessageCacheBreakpoint(messages.filter(message => !restoredMessages.has(message)));

  return request;
};
