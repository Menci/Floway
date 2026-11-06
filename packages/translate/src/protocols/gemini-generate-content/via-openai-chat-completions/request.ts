import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec } from '../../../types.ts';
import { openaiChatCompletionsRequestFromIR } from '../../openai-chat-completions/as-target/input-from.ts';
import { partitionGeminiGenerateContentTurns } from '../as-source/conversation-turns.ts';
import { geminiGenerateContentDropsReasoning, geminiGenerateContentRequestToIR, geminiGenerateContentSystemToIR, geminiGenerateContentTurnToIR } from '../as-source/input-to.ts';
import { collectGeminiGenerateContentReplayContents, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest } from '../as-source/round-trip.ts';
import type { GeminiGenerateContentToolCallIds } from '../as-source/tools.ts';
import type { GeminiGenerateContentPayload } from '@floway-dev/protocols/gemini-generate-content';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsMessage } from '@floway-dev/protocols/openai-chat-completions';

export const buildTargetRequest = async (
  payload: GeminiGenerateContentPayload,
  model: string,
  codec: SidecarCodec,
): Promise<OpenAIChatCompletionsPayload> => {
  const unmatchedToolCallIds: GeminiGenerateContentToolCallIds = Object.create(null);
  const ir = geminiGenerateContentRequestToIR(payload, model);
  const messages: OpenAIChatCompletionsMessage[] = [];

  let contentIndex = 0;
  const pieces: (IRInputTurn | IRInputResolvedTurn<OpenAIChatCompletionsMessage>)[] = [];
  for (const turn of partitionGeminiGenerateContentTurns(payload.contents ?? [])) {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('geminiGenerateContent', 'openaiChatCompletions', turn.items, codec, findGeminiGenerateContentSidecarCarriers, verifyGeminiGenerateContentTurnDigest, collectGeminiGenerateContentReplayContents);
      if (roundTrip !== undefined) {
        pieces.push({ kind: 'resolved', turn: roundTrip.turn });
        if (roundTrip.turn.function_call == null) {
          for (const call of roundTrip.turn.tool_calls ?? []) {
            const name = call.type === 'function' ? call.function.name : call.custom.name;
            unmatchedToolCallIds[name] ??= [];
            unmatchedToolCallIds[name].push(call.id);
          }
        }
        contentIndex += turn.items.length;
        continue;
      }
    }
    if (geminiGenerateContentDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('geminiGenerateContent', 'openaiChatCompletions');
    pieces.push(geminiGenerateContentTurnToIR(turn, contentIndex, unmatchedToolCallIds));
    contentIndex += turn.items.length;
  }

  // The system instruction is the conversation's leading prompt and joins the
  // pieces as its own segment, so the writer places it like any other turn.
  const system = geminiGenerateContentSystemToIR(payload.systemInstruction);
  if (system !== undefined) pieces.unshift(system);

  let base: OpenAIChatCompletionsPayload | undefined;
  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') { messages.push(piece.turn); continue; }
    const translated = openaiChatCompletionsRequestFromIR({ ...ir, conversation: { turns: piece.turns } });
    base ??= translated;
    messages.push(...translated.messages);
  }
  base ??= openaiChatCompletionsRequestFromIR({ ...ir, conversation: { turns: [] } });

  return { ...base, messages };
};
