import { applyLastMessageCacheBreakpoint, applyLastSystemCacheBreakpoint, applyLastToolCacheBreakpoint } from './cache-breakpoints.ts';
import { anthropicMessagesRequestFromIR, type AnthropicMessagesRequestFromIROptions } from './input-from.ts';
import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputRequest, IRInputTurn } from '../../../ir/input/types.ts';
import type { AnthropicMessagesMessage, AnthropicMessagesPayload, AnthropicMessagesTextBlockParam } from '@floway-dev/protocols/anthropic-messages';

const systemBlocksOf = (system: AnthropicMessagesPayload['system']): AnthropicMessagesTextBlockParam[] =>
  system === undefined ? [] : typeof system === 'string' ? [{ type: 'text', text: system }] : system;

/**
 * Writes a segmented conversation as one Messages payload.
 *
 * A conversation splits at the assistant turns a sidecar already resolved: those
 * are native Messages structure, so they are placed verbatim while every other
 * segment is written from the IR. The request-wide fields come from the first
 * translated segment; later segments contribute only their messages.
 *
 * The writer can only place a cache breakpoint once it has the complete
 * payload, so the breakpoints are applied here rather than per segment. A
 * resolved message is already what the source vendor sent back, so it never
 * takes a breakpoint this translation invents.
 */
export const anthropicMessagesPayloadFromSegments = async <Restored>(
  request: IRInputRequest,
  pieces: readonly (IRInputTurn | IRInputResolvedTurn<Restored>)[],
  resolvedMessage: (turn: Restored) => AnthropicMessagesMessage,
  options: AnthropicMessagesRequestFromIROptions = {},
): Promise<AnthropicMessagesPayload> => {
  const system: AnthropicMessagesTextBlockParam[] = [];
  const messages: AnthropicMessagesMessage[] = [];
  const restored = new Set<AnthropicMessagesMessage>();
  let base: AnthropicMessagesPayload | undefined;
  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') {
      const message = resolvedMessage(piece.turn);
      messages.push(message);
      restored.add(message);
      continue;
    }
    const translated = await anthropicMessagesRequestFromIR({ ...request, conversation: { turns: piece.turns } }, options);
    base ??= translated;
    system.push(...systemBlocksOf(translated.system));
    messages.push(...translated.messages);
  }
  base ??= await anthropicMessagesRequestFromIR({ ...request, conversation: { turns: [] } }, options);

  // Messages requires a non-empty user content array. An item whose parts were
  // all dropped — an image the resolver could not fetch — leaves one empty text
  // block rather than a payload the wire rejects.
  const complete = messages.map(message => message.role === 'user' && Array.isArray(message.content) && message.content.length === 0
    ? { ...message, content: [{ type: 'text' as const, text: '' }] }
    : message);

  const target: AnthropicMessagesPayload = {
    ...base,
    messages: complete,
    ...(system.length === 0 ? {} : { system }),
  };
  applyLastSystemCacheBreakpoint(system);
  applyLastToolCacheBreakpoint(target.tools);
  applyLastMessageCacheBreakpoint(complete.filter(message => !restored.has(message)));
  return target;
};
