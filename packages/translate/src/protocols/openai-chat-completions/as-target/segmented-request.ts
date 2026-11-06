import { openaiChatCompletionsRequestFromIR } from './input-from.ts';
import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputRequest, IRInputTurn } from '../../../ir/input/types.ts';
import type { OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

/**
 * Writes a segmented conversation as one Chat Completions payload.
 *
 * A conversation splits at the assistant turns a sidecar already resolved:
 * those are native Chat messages, so they are placed verbatim while every other
 * segment is written from the IR. The request-wide fields come from the first
 * translated segment; later segments contribute only their messages.
 *
 * Chat states no top-level prompt slot, so a leading prompt stays an ordinary
 * message wherever the caller put it.
 */
export const openaiChatCompletionsPayloadFromSegments = <Restored extends OpenAIChatCompletionsMessage>(
  request: IRInputRequest,
  pieces: readonly (IRInputTurn | IRInputResolvedTurn<Restored>)[],
  resolvedMessage: (turn: Restored) => OpenAIChatCompletionsMessage,
): OpenAIChatCompletionsPayload => {
  const messages: OpenAIChatCompletionsMessage[] = [];
  let base: OpenAIChatCompletionsPayload | undefined;
  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') { messages.push(resolvedMessage(piece.turn)); continue; }
    const translated = openaiChatCompletionsRequestFromIR({ ...request, conversation: { turns: piece.turns } });
    base ??= translated;
    messages.push(...translated.messages);
  }
  base ??= openaiChatCompletionsRequestFromIR({ ...request, conversation: { turns: [] } });
  return { ...base, messages };
};
