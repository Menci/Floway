import { applyLastMessageCacheBreakpoint, applyLastSystemCacheBreakpoint, applyLastToolCacheBreakpoint } from './cache-breakpoints.ts';
import { anthropicMessagesConversationFromIR, anthropicMessagesHeaderFromIR } from './input-from.ts';
import { type RestoredAssistantTurn } from '../../../composition/reading.ts';
import type { IRInputRequestHeader } from '../../../ir/input/types.ts';
import type { IRInputTurnWithCallIds } from '../../../request/call-ids.ts';
import { segmentTurns } from '../../../request/segments.ts';
import type { TranslateOptions } from '../../../types.ts';
import type { AnthropicMessagesMessage, AnthropicMessagesPayload, AnthropicMessagesTextBlockParam } from '@floway-dev/protocols/anthropic-messages';

/**
 * Writes a segmented conversation as one Messages payload.
 *
 * A conversation splits at the assistant turns a sidecar already resolved: those
 * are native Messages structure, so they are placed verbatim while every other
 * segment is written from the IR. The request-wide fields are one answer for
 * the whole conversation, so they are computed once beside it.
 *
 * The writer can only place a cache breakpoint once it has the complete
 * payload, so the breakpoints are applied here rather than per segment. A
 * resolved message is already what the source vendor sent back, so it never
 * takes a breakpoint this translation invents.
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

  // The request-level fields are one answer for the whole conversation, so they
  // are computed once rather than per segment. The writer can only place a cache
  // breakpoint once it has the complete payload, so those are applied here. A
  // resolved message is already what the source vendor sent back, so it never
  // takes a breakpoint this translation invents.
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
