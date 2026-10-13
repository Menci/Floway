import type { IRJSONObject, IRJSONValue } from '../../../ir/types.ts';
import { replayMaterialsByType, verifyRoundTripReplayCheck, type RoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripAssistantTurnInspection } from '../../../round-trip/replay.ts';
import { requireJSONObject } from '../../../shared/json/object.ts';
import type { AnthropicMessagesAssistantContentBlock, AnthropicMessagesAssistantMessage } from '@floway-dev/protocols/anthropic-messages';

export type AnthropicMessagesAssistantTurn = (AnthropicMessagesAssistantMessage | { role: 'assistant'; content: AnthropicMessagesAssistantContentBlock[] })[];

type TypedReplayMaterial = IRJSONObject & { type: string };

const messagesReplayCheckMaterialV1 = (turn: AnthropicMessagesAssistantTurn): IRJSONValue => {
  const blocks: TypedReplayMaterial[] = [];
  for (const message of turn) {
    if (typeof message.content === 'string') {
      blocks.push({ type: 'text', text: message.content, citations: [] });
      continue;
    }
    for (const block of message.content) {
      if (block.type === 'text') blocks.push({
        type: block.type,
        text: block.text,
        citations: block.citations?.map(citation => citation.cited_text) ?? [],
      });
      else if (block.type === 'thinking') blocks.push({ type: block.type, thinking: block.thinking });
      else if (block.type === 'tool_use') blocks.push({ type: block.type, id: block.id, name: block.name, input: requireJSONObject(block.input) });
      else blocks.push({ type: block.type });
    }
  }
  return replayMaterialsByType(blocks);
};

export const inspectAnthropicMessagesAssistantTurn = (turn: AnthropicMessagesAssistantTurn): RoundTripAssistantTurnInspection<AnthropicMessagesAssistantTurn> => {
  const sidecars: string[] = [];
  const assistantTurn = turn.map(message => typeof message.content === 'string' ? message : {
    ...message,
    content: message.content.filter(block => {
      if (block.type !== 'redacted_thinking') return true;
      sidecars.push(block.data);
      return false;
    }),
  });
  return {
    sidecars,
    turn: assistantTurn,
  };
};

export const verifyAnthropicMessagesReplayCheck = (
  turn: AnthropicMessagesAssistantTurn,
  replayCheck: RoundTripReplayCheck,
): Promise<boolean> => {
  switch (replayCheck.version) {
  case 1: return verifyRoundTripReplayCheck(messagesReplayCheckMaterialV1(turn), replayCheck);
  default: return Promise.resolve(false);
  }
};
