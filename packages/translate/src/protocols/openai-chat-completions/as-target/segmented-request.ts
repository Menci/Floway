import { openaiChatCompletionsConversationFromIR, openaiChatCompletionsHeaderFromIR } from './input-from.ts';
import { type RestoredAssistantTurn } from '../../../composition/reading.ts';
import type { IRInputRequestHeader } from '../../../ir/input/types.ts';
import type { IRInputTurnWithCallIds } from '../../../request/call-ids.ts';
import { segmentTurns } from '../../../request/segments.ts';
import type { OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

/**
 * Preserve restored native Chat turns verbatim and compute request-wide fields once.
 * Chat has no top-level prompt slot, so prompts retain their inline positions.
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
  return { ...openaiChatCompletionsHeaderFromIR(request), messages };
};
