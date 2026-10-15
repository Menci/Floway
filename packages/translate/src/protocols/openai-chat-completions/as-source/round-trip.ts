import type { IRJSONObject, IRJSONValue } from '../../../ir/types.ts';
import { computeRoundTripReplayCheck, verifyRoundTripReplayCheck, type RoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripAssistantTurnInspection } from '../../../round-trip/replay.ts';
import type { ReplayCandidate } from '../../../round-trip/thin/assistant-turn.ts';
import type { OpenAIChatCompletionsAssistantExtensions, OpenAIChatCompletionsAssistantMessage, OpenAIChatCompletionsAssistantOutputMessage, OpenAIChatCompletionsToolCallEx } from '@floway-dev/protocols/openai-chat-completions';

export const OPENAI_CHAT_COMPLETIONS_REPLAY_CHECK_VERSION = 1;

export type OpenAIChatCompletionsAssistantTurn = (OpenAIChatCompletionsAssistantMessage | OpenAIChatCompletionsAssistantOutputMessage)
  & Pick<OpenAIChatCompletionsAssistantExtensions, 'reasoning' | 'reasoning_text' | 'reasoning_content' | 'reasoning_details'>;

export type OpenAIChatCompletionsReasoningDetailsCarrier = { type: 'reasoning.encrypted'; data: string; format: 'unknown'; index: 1 };

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

export const hasOpenAIChatCompletionsReasoning = (turn: OpenAIChatCompletionsAssistantTurn): boolean =>
  reasoningFields.some(field => turn[field] != null) || reasoningDetails(turn).length > 0;

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

const readReasoningDetailsSummary = (turn: OpenAIChatCompletionsAssistantTurn): string[] => reasoningDetails(turn).flatMap(value => {
  const item = isRecord(value) ? value : undefined;
  return item?.type === 'reasoning.summary' && typeof item.summary === 'string' ? [item.summary] : [];
});

const collectString = (candidates: ReplayCandidate[], value: string | null | undefined): void => {
  if (typeof value === 'string') candidates.push(value);
};

export const inspectOpenAIChatCompletionsAssistantTurn = (turn: OpenAIChatCompletionsAssistantTurn): RoundTripAssistantTurnInspection<OpenAIChatCompletionsAssistantTurn> => {
  const sidecars: string[] = [];
  const details = reasoningDetails(turn).filter(value => {
    if (!isRecord(value) || value.type !== 'reasoning.encrypted' || typeof value.data !== 'string') return true;
    sidecars.push(value.data);
    return false;
  });
  const assistantTurn = Array.isArray(turn.reasoning_details) ? { ...turn, reasoning_details: details } : turn;
  const candidates: ReplayCandidate[] = [];
  if (typeof assistantTurn.content === 'string') collectString(candidates, assistantTurn.content);
  else if (Array.isArray(assistantTurn.content)) for (const part of assistantTurn.content) collectString(candidates, part.type === 'text' ? part.text : part.refusal);
  collectString(candidates, assistantTurn.refusal);
  for (const field of reasoningFields) collectString(candidates, assistantTurn[field]);
  candidates.push(...readReasoningDetailsSummary(assistantTurn));
  if (assistantTurn.function_call !== undefined && assistantTurn.function_call !== null) collectString(candidates, assistantTurn.function_call.arguments);
  for (const call of assistantTurn.tool_calls ?? []) collectString(candidates, call.type === 'function' ? call.function.arguments : call.custom.input);
  return {
    sidecars,
    turn: assistantTurn,
    candidates,
  };
};

export const computeOpenAIChatCompletionsReplayCheck = (turn: OpenAIChatCompletionsAssistantTurn): Promise<RoundTripReplayCheck> =>
  computeRoundTripReplayCheck(OPENAI_CHAT_COMPLETIONS_REPLAY_CHECK_VERSION, chatReplayCheckMaterialV1(turn));

export const verifyOpenAIChatCompletionsReplayCheck = (
  turn: OpenAIChatCompletionsAssistantTurn,
  replayCheck: RoundTripReplayCheck,
): Promise<boolean> => {
  switch (replayCheck.version) {
  case 1: return verifyRoundTripReplayCheck(chatReplayCheckMaterialV1(turn), replayCheck);
  default: return Promise.resolve(false);
  }
};

// Our carrier uses indexed OpenRouter reasoning_details.
// https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#reasoning-details-api-shape
export const createOpenAIChatCompletionsSidecarCarrier = (data: string): OpenAIChatCompletionsReasoningDetailsCarrier[] =>
  [{ type: 'reasoning.encrypted', data, format: 'unknown', index: 1 }];
