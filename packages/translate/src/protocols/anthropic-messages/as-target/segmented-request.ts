import { withLastMessageCacheBreakpoint, withLastSystemCacheBreakpoint, withLastToolCacheBreakpoint } from './cache-breakpoints.ts';
import { anthropicMessagesConversationFromIR, anthropicMessagesHeaderFromIR } from './input-from.ts';
import { type RestoredAssistantTurn } from '../../../composition/reading.ts';
import type { IRInputTurnWithCallIds } from '../../../composition/request/call-ids.ts';
import { segmentTurns } from '../../../composition/request/segments.ts';
import type { IRInputRequestHeader } from '../../../ir/input/types.ts';
import type { TranslateOptions } from '../../../types.ts';
import type { AnthropicMessagesMessage, AnthropicMessagesPayload, AnthropicMessagesTextBlockParam } from '@floway-dev/protocols/anthropic-messages';

/**
 * Preserve restored native Messages turns verbatim and compute request-wide fields once.
 * Place cache breakpoints after complete assembly, leaving restored turns untouched.
 */
export const anthropicMessagesPayloadFromSegments = (
  request: IRInputRequestHeader,
  turns: readonly (IRInputTurnWithCallIds | RestoredAssistantTurn<AnthropicMessagesMessage>)[],
  options: Pick<TranslateOptions, 'fallbackMaxOutputTokens'>,
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
    // Only the first segment may project its instruction or leading
    // system/developer messages into the top-level `system` slot.
    const segment = anthropicMessagesConversationFromIR(piece.turns, piece.leading);
    system.push(...segment.system);
    messages.push(...segment.messages);
  }

  const header = anthropicMessagesHeaderFromIR(request, options);
  return {
    ...header,
    ...(header.tools === undefined ? {} : { tools: withLastToolCacheBreakpoint(header.tools) }),
    messages: withLastMessageCacheBreakpoint(messages, restored),
    ...(system.length === 0 ? {} : { system: withLastSystemCacheBreakpoint(system) }),
  };
};
