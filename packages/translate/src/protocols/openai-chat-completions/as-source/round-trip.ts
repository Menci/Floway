import type { IRJSONObject, IRJSONValue } from '../../../ir/types.ts';
import { verifyRoundTripReplayCheck, type RoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripAssistantTurnInspection } from '../../../round-trip/replay.ts';
import type { OpenAIChatCompletionsAssistantExtensions, OpenAIChatCompletionsAssistantMessage, OpenAIChatCompletionsAssistantOutputMessage, OpenAIChatCompletionsToolCallEx } from '@floway-dev/protocols/openai-chat-completions';

export type OpenAIChatCompletionsAssistantTurn = (OpenAIChatCompletionsAssistantMessage | OpenAIChatCompletionsAssistantOutputMessage)
  & Pick<OpenAIChatCompletionsAssistantExtensions, 'reasoning' | 'reasoning_text' | 'reasoning_content' | 'reasoning_details'>;

const reasoningFields = ['reasoning', 'reasoning_text', 'reasoning_content'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const reasoningDetails = (turn: OpenAIChatCompletionsAssistantTurn): unknown[] => Array.isArray(turn.reasoning_details) ? turn.reasoning_details : [];

const reasoningDetailsMaterial = (turn: OpenAIChatCompletionsAssistantTurn): IRJSONObject[] => {
  const materials: IRJSONObject[] = [];
  for (const value of reasoningDetails(turn)) {
    const item = isRecord(value) ? value : undefined;
    if (item?.type === 'reasoning.summary' && typeof item.summary === 'string') materials.push({ type: item.type, summary: item.summary });
    else if (typeof item?.type === 'string') materials.push({ type: item.type });
    else materials.push({});
  }
  return materials;
};

const messageContentMaterial = (turn: OpenAIChatCompletionsAssistantTurn): IRJSONValue | undefined => {
  if (typeof turn.content === 'string' || turn.content === null || turn.content === undefined) return turn.content;
  const parts: IRJSONObject[] = [];
  for (const part of turn.content) parts.push(part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'refusal', refusal: part.refusal });
  return parts;
};

const toolCallMaterial = (call: OpenAIChatCompletionsToolCallEx): IRJSONObject => call.type === 'function'
  ? { type: 'function', id: call.id, name: call.function.name, arguments: call.function.arguments }
  : { type: 'custom', id: call.id, name: call.custom.name, input: call.custom.input };

const reasoningTextMaterial = (turn: OpenAIChatCompletionsAssistantTurn): IRJSONObject[] => {
  const materials: IRJSONObject[] = [];
  for (const field of reasoningFields) {
    if (!Object.hasOwn(turn, field)) continue;
    const value = turn[field];
    materials.push(value === undefined ? { field } : { field, value });
  }
  return materials;
};

const chatReplayCheckMaterialV1 = (turn: OpenAIChatCompletionsAssistantTurn): IRJSONObject => ({
  ...(Object.hasOwn(turn, 'content') && turn.content !== undefined ? { content: messageContentMaterial(turn) } : {}),
  ...(Object.hasOwn(turn, 'refusal') && turn.refusal !== undefined ? { refusal: turn.refusal } : {}),
  ...(turn.function_call != null
    ? { function_call: { name: turn.function_call.name, arguments: turn.function_call.arguments } }
    : turn.function_call === null ? { function_call: null } : {}),
  ...(turn.tool_calls !== undefined ? { tool_calls: turn.tool_calls.map(toolCallMaterial) } : {}),
  reasoningText: reasoningTextMaterial(turn),
  reasoningDetails: reasoningDetailsMaterial(turn),
});

export const inspectOpenAIChatCompletionsAssistantTurn = (turn: OpenAIChatCompletionsAssistantTurn): RoundTripAssistantTurnInspection<OpenAIChatCompletionsAssistantTurn> => {
  const sidecars: string[] = [];
  const details = reasoningDetails(turn).filter(value => {
    if (!isRecord(value) || value.type !== 'reasoning.encrypted' || typeof value.data !== 'string') return true;
    sidecars.push(value.data);
    return false;
  });
  return {
    sidecars,
    turn: Array.isArray(turn.reasoning_details) ? { ...turn, reasoning_details: details } : turn,
  };
};

export const verifyOpenAIChatCompletionsReplayCheck = (
  turn: OpenAIChatCompletionsAssistantTurn,
  replayCheck: RoundTripReplayCheck,
): Promise<boolean> => {
  switch (replayCheck.version) {
  case 1: return verifyRoundTripReplayCheck(chatReplayCheckMaterialV1(turn), replayCheck);
  default: return Promise.resolve(false);
  }
};
