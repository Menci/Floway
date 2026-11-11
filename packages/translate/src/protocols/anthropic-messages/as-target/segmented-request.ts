import { applyLastMessageCacheBreakpoint, applyLastSystemCacheBreakpoint, applyLastToolCacheBreakpoint } from './cache-breakpoints.ts';
import { anthropicMessagesConversationFromIR, anthropicMessagesHeaderFromIR } from './input-from.ts';
import { type RestoredAssistantTurn } from '../../../composition/reading.ts';
import type { IRInputRequestHeader } from '../../../ir/input/types.ts';
import type { IRInputTurnWithCallIds } from '../../../request/call-ids.ts';
import { segmentTurns } from '../../../request/segments.ts';
import type { TranslateOptions } from '../../../types.ts';
import type { AnthropicMessagesMessage, AnthropicMessagesPayload, AnthropicMessagesTextBlockParam } from '@floway-dev/protocols/anthropic-messages';

/**
 * Preserve restored native Messages turns verbatim and compute request-wide fields once.
 * Apply cache breakpoints after complete assembly, leaving restored turns untouched.
 */
export const anthropicMessagesPayloadFromSegments = (
  request: IRInputRequestHeader,
  turns: readonly (IRInputTurnWithCallIds | RestoredAssistantTurn<AnthropicMessagesMessage>)[],
  options: Pick<TranslateOptions, 'fallbackMaxOutputTokens'> = {},
): AnthropicMessagesPayload => {
  const system: AnthropicMessagesTextBlockParam[] = [];
  const messages: AnthropicMessagesMessage[] = [];
  const restored = new Set<AnthropicMessagesMessage>();
  for (const piece of segmentTurns(turns)) {
    if (piece.kind === 'restored') {
      messages.push(piece.turn);
      restored.add(piece.turn);
      continue;
    }
    // Only a conversation's first segment may lift its leading prompt into the
    // top-level `system` slot, and segmentation is what says which that is.
    const segment = anthropicMessagesConversationFromIR(piece.turns, piece.leading);
    system.push(...segment.system);
    messages.push(...segment.messages);
  }

  const target: AnthropicMessagesPayload = {
    ...anthropicMessagesHeaderFromIR(request, options),
    messages,
    ...(system.length === 0 ? {} : { system }),
  };
  applyLastSystemCacheBreakpoint(system);
  applyLastToolCacheBreakpoint(target.tools);
  applyLastMessageCacheBreakpoint(messages.filter(message => !restored.has(message)));
  return target;
};
