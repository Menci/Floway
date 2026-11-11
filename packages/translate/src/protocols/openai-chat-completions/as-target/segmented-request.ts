import { openaiChatCompletionsConversationFromIR, openaiChatCompletionsHeaderFromIR } from './input-from.ts';
import { type RestoredAssistantTurn } from '../../../composition/reading.ts';
import type { IRInputRequestHeader } from '../../../ir/input/types.ts';
import type { IRInputTurnWithCallIds } from '../../../request/call-ids.ts';
import { segmentTurns } from '../../../request/segments.ts';
import type { OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

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
export const openaiChatCompletionsPayloadFromSegments = (
  request: IRInputRequestHeader,
  turns: readonly (IRInputTurnWithCallIds | RestoredAssistantTurn<OpenAIChatCompletionsMessage>)[],
  // The legacy call each result answers, by the id that result carries. Only
  // this writer reads it: a legacy call has no id to answer with, so its answer
  // is stated in the `function` form this wire pairs with the field.
  legacyCallNames: ReadonlyMap<string, string>,
): OpenAIChatCompletionsPayload => {
  const messages: OpenAIChatCompletionsMessage[] = [];
  for (const piece of segmentTurns(turns)) {
    if (piece.kind === 'restored') { messages.push(piece.turn); continue; }
    messages.push(...openaiChatCompletionsConversationFromIR(piece.turns, legacyCallNames));
  }
  // The request-level fields are one answer for the whole conversation, so they
  // are computed once rather than per segment.
  return { ...openaiChatCompletionsHeaderFromIR(request), messages };
};
