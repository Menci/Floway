import type { IRJSONObject, IRJSONValue } from '../../../ir/types.ts';
import { computeRoundTripReplayCheck, verifyRoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripSidecarCandidate } from '../../../round-trip/replay.ts';
import { canonicalTextParts, collectCanonicalTextViews, isPureTextPart, type CanonicalTextView, type PureTextPart } from '../../../round-trip/text-parts.ts';
import type { ReplayCandidate } from '../../../round-trip/thin/assistant-turn.ts';
import type { OpenAIChatCompletionsAssistantExtensions, OpenAIChatCompletionsAssistantMessage, OpenAIChatCompletionsAssistantOutputMessage, OpenAIChatCompletionsToolCallEx } from '@floway-dev/protocols/openai-chat-completions';

type OpenAIChatCompletionsReplayPart = NonNullable<Exclude<OpenAIChatCompletionsAssistantTurn['content'], string>>[number];

const isOpenAIChatCompletionsPureTextPart = <Part extends OpenAIChatCompletionsReplayPart>(part: Part): part is Part & PureTextPart =>
  isPureTextPart(part, ['text']);

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
  for (const part of canonicalTextParts(turn.content, isOpenAIChatCompletionsPureTextPart)) parts.push(part.type === 'text'
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

export const inspectOpenAIChatCompletionsAssistantTurn = (turn: OpenAIChatCompletionsAssistantTurn): RoundTripSidecarCandidate<OpenAIChatCompletionsAssistantTurn>[] => {
  const details = reasoningDetails(turn);
  return details.flatMap((detail, detailIndex) => !isRecord(detail) || detail.type !== 'reasoning.encrypted' || typeof detail.data !== 'string' ? [] : [{
    data: detail.data,
    withoutSidecar: () => ({ ...turn, reasoning_details: details.filter((_, index) => index !== detailIndex) }),
  }]);
};

export const computeOpenAIChatCompletionsReplayCheck = (turn: OpenAIChatCompletionsAssistantTurn): Promise<RoundTripReplayCheck> =>
  computeRoundTripReplayCheck(OPENAI_CHAT_COMPLETIONS_REPLAY_CHECK_VERSION, chatReplayCheckMaterialV1(turn));

export const collectOpenAIChatCompletionsReplayCandidates = (turn: OpenAIChatCompletionsAssistantTurn): ReplayCandidate[] => {
  const candidates: ReplayCandidate[] = [];
  const collectString = (value: string | null | undefined): void => {
    if (typeof value === 'string') candidates.push(value);
  };
  if (typeof turn.content === 'string') collectString(turn.content);
  else if (Array.isArray(turn.content)) for (const part of canonicalTextParts(turn.content, isOpenAIChatCompletionsPureTextPart)) collectString(part.type === 'text' ? part.text : part.refusal);
  collectString(turn.refusal);
  for (const field of reasoningFields) collectString(turn[field]);
  for (const value of reasoningDetails(turn)) {
    if (isRecord(value) && value.type === 'reasoning.summary' && typeof value.summary === 'string') candidates.push(value.summary);
  }
  if (turn.function_call != null) collectString(turn.function_call.arguments);
  for (const call of turn.tool_calls ?? []) collectString(call.type === 'function' ? call.function.arguments : call.custom.input);
  return candidates;
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

// Our carrier uses indexed OpenRouter reasoning_details.
// https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#reasoning-details-api-shape
export const createOpenAIChatCompletionsSidecarCarrier = (data: string): OpenAIChatCompletionsReasoningDetailsCarrier[] =>
  [{ type: 'reasoning.encrypted', data, format: 'unknown', index: 1 }];

export const collectOpenAIChatCompletionsTextViews = (turn: OpenAIChatCompletionsAssistantTurn): Map<object, CanonicalTextView> => {
  const views = new Map<object, CanonicalTextView>();
  if (Array.isArray(turn.content)) collectCanonicalTextViews(turn.content, isOpenAIChatCompletionsPureTextPart, views);
  return views;
};
