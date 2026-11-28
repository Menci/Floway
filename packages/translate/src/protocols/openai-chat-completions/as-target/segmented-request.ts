import { openaiChatCompletionsConversationFromIR, openaiChatCompletionsHeaderFromIR } from './input-from.ts';
import { type RestoredAssistantTurn } from '../../../composition/reading.ts';
import type { IRInputToolResultItemWithCallId, IRInputTurnWithCallIds } from '../../../composition/request/call-ids.ts';
import { segmentTurns } from '../../../composition/request/segments.ts';
import type { IRInputRequestHeader } from '../../../ir/input/types.ts';
import type { OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

/**
 * Preserve restored native Chat turns verbatim and compute request-wide fields once.
 * Chat has no top-level instruction slot, so instructions become inline messages.
 */
export const openaiChatCompletionsPayloadFromSegments = (
  request: IRInputRequestHeader,
  turns: readonly (IRInputTurnWithCallIds | RestoredAssistantTurn<OpenAIChatCompletionsMessage>)[],
  // The legacy call each matched tool_result answers. Only this writer reads it:
  // a legacy call has no wire id, so its answer is stated in the `function` form.
  legacyCallNames: ReadonlyMap<IRInputToolResultItemWithCallId, string>,
): OpenAIChatCompletionsPayloadEx => {
  const messages: OpenAIChatCompletionsMessage[] = [];
  for (const piece of segmentTurns(turns)) {
    if (piece.kind === 'restored') { messages.push(piece.turn); continue; }
    messages.push(...openaiChatCompletionsConversationFromIR(piece.turns, legacyCallNames));
  }
  return { ...openaiChatCompletionsHeaderFromIR(request), messages };
};
