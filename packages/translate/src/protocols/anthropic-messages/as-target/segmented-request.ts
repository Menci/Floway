import { applyLastMessageCacheBreakpoint, applyLastSystemCacheBreakpoint, applyLastToolCacheBreakpoint } from './cache-breakpoints.ts';
import { anthropicMessagesConversationFromIR, anthropicMessagesHeaderFromIR, type AnthropicMessagesRequestFromIROptions } from './input-from.ts';
import type { IRInputAddressedTurn } from '../../../ir/input/addressed.ts';
import type { IRInputRequestHeader } from '../../../ir/input/types.ts';
import { segmentTurns, type ResolvedTurn } from '../../composition/segments.ts';
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
export const anthropicMessagesPayloadFromSegments = <Restored>(
  request: IRInputRequestHeader,
  turns: readonly (IRInputAddressedTurn | ResolvedTurn<Restored>)[],
  resolvedMessage: (turn: Restored) => AnthropicMessagesMessage,
  options: AnthropicMessagesRequestFromIROptions = {},
): AnthropicMessagesPayload => {
  const system: AnthropicMessagesTextBlockParam[] = [];
  const messages: AnthropicMessagesMessage[] = [];
  const restored = new Set<AnthropicMessagesMessage>();
  for (const piece of segmentTurns(turns)) {
    if (piece.kind === 'resolved') {
      const message = resolvedMessage(piece.turn);
      messages.push(message);
      restored.add(message);
      continue;
    }
    // Only a conversation's first segment may lift its leading prompt into the
    // top-level `system` slot, and segmentation is what says which that is.
    const segment = anthropicMessagesConversationFromIR(piece.turns, piece.leading);
    system.push(...segment.system);
    messages.push(...segment.messages);
  }

  // Messages requires a non-empty user content array. An item whose parts were
  // all dropped — an image the resolver could not fetch — leaves one empty text
  // block rather than a payload the wire rejects.
  const complete = messages.map(message => message.role === 'user' && Array.isArray(message.content) && message.content.length === 0
    ? { ...message, content: [{ type: 'text' as const, text: '' }] }
    : message);

  // The request-level fields are one answer for the whole conversation, so they
  // are computed once rather than per segment. The writer can only place a cache
  // breakpoint once it has the complete payload, so those are applied here. A
  // resolved message is already what the source vendor sent back, so it never
  // takes a breakpoint this translation invents.
  const target: AnthropicMessagesPayload = {
    ...anthropicMessagesHeaderFromIR(request, options),
    messages: complete,
    ...(system.length === 0 ? {} : { system }),
  };
  applyLastSystemCacheBreakpoint(system);
  applyLastToolCacheBreakpoint(target.tools);
  applyLastMessageCacheBreakpoint(complete.filter(message => !restored.has(message)));
  return target;
};
