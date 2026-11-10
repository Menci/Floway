import { openaiChatCompletionsConversationFromIR, openaiChatCompletionsHeaderFromIR } from './input-from.ts';
import type { IRInputAddressedTurn } from '../../../ir/input/addressed.ts';
import type { IRInputRequestHeader } from '../../../ir/input/types.ts';
import { segmentTurns, type ResolvedTurn } from '../../composition/segments.ts';
import type { OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

/** The id this payload gives a legacy `function_call`. */
export const legacyFunctionCallId = (name: string): string => `legacy_call:${name}`;

/** Every legacy call these turns state, by the id the writer invented for it. */
export const legacyFunctionCallNamesOf = <Restored extends OpenAIChatCompletionsMessage>(
  turns: readonly (IRInputAddressedTurn | ResolvedTurn<Restored>)[],
): ReadonlyMap<string, string> => {
  const legacy = new Map<string, string>();
  for (const piece of turns) {
    if (piece.kind !== 'resolved') continue;
    const name = piece.turn.role === 'assistant' ? piece.turn.function_call?.name : undefined;
    if (name !== undefined) legacy.set(legacyFunctionCallId(name), name);
  }
  return legacy;
};

/**
 * Writes a segmented conversation as one Chat Completions payload.
 *
 * A conversation splits at the assistant turns a sidecar already resolved:
 * those are native Chat messages, so they are placed verbatim while every other
 * segment is written from the IR. The request-wide fields are one answer for
 * the whole conversation, so they are computed once beside it.
 *
 * Chat states no top-level prompt slot, so a leading prompt stays an ordinary
 * message wherever the caller put it.
 */
export const openaiChatCompletionsPayloadFromSegments = <Restored extends OpenAIChatCompletionsMessage>(
  request: IRInputRequestHeader,
  turns: readonly (IRInputAddressedTurn | ResolvedTurn<Restored>)[],
  resolvedMessage: (turn: Restored) => OpenAIChatCompletionsMessage,
  // Results that answer a legacy `function_call` are written as the legacy
  // `function` message, which is the only one this wire pairs with that field.
  legacyFunctionCallNames: ReadonlyMap<string, string>,
): OpenAIChatCompletionsPayload => {
  const messages: OpenAIChatCompletionsMessage[] = [];
  for (const piece of segmentTurns(turns)) {
    if (piece.kind === 'resolved') { messages.push(resolvedMessage(piece.turn)); continue; }
    messages.push(...openaiChatCompletionsConversationFromIR(piece.turns, legacyFunctionCallNames));
  }
  // The request-level fields are one answer for the whole conversation, so they
  // are computed once rather than per segment.
  return { ...openaiChatCompletionsHeaderFromIR(request), messages };
};
