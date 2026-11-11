import type { IRJSONObject, IRJSONValue } from '../../../ir/common/json.ts';
import type { ReplayContent } from '../../../round-trip/reference/types.ts';
import type { SidecarOccurrence } from '../../../round-trip/resolve.ts';
import { collectTextGroups, collectTextPlacementIndex, type TextContribution, type TextPlacementIndex } from '../../../round-trip/text-groups.ts';
import { createTurnDigestComputer, createTurnDigestVerifier } from '../../../round-trip/turn-digest.ts';
import { isJSONRecord } from '../../../shared/json/object.ts';
import type { OpenAIChatCompletionsAssistantExtensions, OpenAIChatCompletionsAssistantMessage, OpenAIChatCompletionsAssistantOutputMessage, OpenAIChatCompletionsToolCallEx } from '@floway-dev/protocols/openai-chat-completions';

type OpenAIChatCompletionsReplayPart = NonNullable<Exclude<OpenAIChatCompletionsSourceAssistantTurn['content'], string>>[number];
type OpenAIChatCompletionsTextGroup = 'text' | 'refusal';

const chatCompletionsTextGroup = (part: OpenAIChatCompletionsReplayPart): TextContribution<OpenAIChatCompletionsTextGroup> =>
  part.type === 'text'
    ? { channel: part.type, field: 'text', text: part.text }
    : { channel: part.type, field: 'refusal', text: part.refusal };

export type OpenAIChatCompletionsSourceAssistantTurn = (OpenAIChatCompletionsAssistantMessage | OpenAIChatCompletionsAssistantOutputMessage)
  & Pick<OpenAIChatCompletionsAssistantExtensions, 'reasoning' | 'reasoning_text' | 'reasoning_content' | 'reasoning_details'>;

export type OpenAIChatCompletionsSidecarDetail = { type: 'reasoning.encrypted'; data: string; format: 'unknown'; index: 1 };

const reasoningFields = ['reasoning', 'reasoning_text', 'reasoning_content'] as const;

const reasoningDetails = (turn: OpenAIChatCompletionsSourceAssistantTurn): unknown[] => Array.isArray(turn.reasoning_details) ? turn.reasoning_details : [];

const reasoningDetailsMaterial = (turn: OpenAIChatCompletionsSourceAssistantTurn): IRJSONObject[] => {
  const materials: IRJSONObject[] = [];
  for (const value of reasoningDetails(turn)) {
    const item = isJSONRecord(value) ? value : undefined;
    if (item?.type === 'reasoning.summary' && typeof item.summary === 'string') materials.push({ type: item.type, summary: item.summary });
    else if (typeof item?.type === 'string') materials.push({ type: item.type });
    else materials.push({});
  }
  return materials;
};

const messageContentMaterial = (turn: OpenAIChatCompletionsSourceAssistantTurn): IRJSONValue | undefined => {
  if (typeof turn.content === 'string' || turn.content === null || turn.content === undefined) return turn.content;
  const channels = collectTextGroups(turn.content, chatCompletionsTextGroup);
  const parts: IRJSONObject[] = [];
  const text = channels.get('text');
  const refusal = channels.get('refusal');
  if (text !== undefined) parts.push({ type: 'text', text: text.text });
  if (refusal !== undefined) parts.push({ type: 'refusal', refusal: refusal.text });
  return parts;
};

const toolCallMaterial = (call: OpenAIChatCompletionsToolCallEx): IRJSONObject => call.type === 'function'
  ? { type: 'function', id: call.id, name: call.function.name, arguments: call.function.arguments }
  : { type: 'custom', id: call.id, name: call.custom.name, input: call.custom.input };

const reasoningTextMaterial = (turn: OpenAIChatCompletionsSourceAssistantTurn): IRJSONObject[] => {
  const materials: IRJSONObject[] = [];
  for (const field of reasoningFields) {
    if (!Object.hasOwn(turn, field)) continue;
    const value = turn[field];
    materials.push(value === undefined ? { field } : { field, value });
  }
  return materials;
};

const chatTurnDigestMaterialV1 = (turn: OpenAIChatCompletionsSourceAssistantTurn): IRJSONObject => ({
  ...(Object.hasOwn(turn, 'content') && turn.content !== undefined ? { content: messageContentMaterial(turn) } : {}),
  ...(Object.hasOwn(turn, 'refusal') && turn.refusal !== undefined ? { refusal: turn.refusal } : {}),
  ...(turn.function_call != null
    ? { function_call: { name: turn.function_call.name, arguments: turn.function_call.arguments } }
    : turn.function_call === null ? { function_call: null } : {}),
  ...(turn.tool_calls !== undefined ? { tool_calls: turn.tool_calls.map(toolCallMaterial) } : {}),
  reasoningText: reasoningTextMaterial(turn),
  reasoningDetails: reasoningDetailsMaterial(turn),
});

export const findOpenAIChatCompletionsSidecarOccurrences = (turn: OpenAIChatCompletionsSourceAssistantTurn): SidecarOccurrence<OpenAIChatCompletionsSourceAssistantTurn>[] => {
  const details = reasoningDetails(turn);
  return details.flatMap((detail, detailIndex) => !isJSONRecord(detail) || detail.type !== 'reasoning.encrypted' || typeof detail.data !== 'string' ? [] : [{
    data: detail.data,
    withoutSidecar: () => ({ ...turn, reasoning_details: details.filter((_, index) => index !== detailIndex) }),
  }]);
};

export const computeOpenAIChatCompletionsTurnDigest = createTurnDigestComputer(chatTurnDigestMaterialV1);

export const collectOpenAIChatCompletionsReplayContents = (turn: OpenAIChatCompletionsSourceAssistantTurn): ReplayContent[] => {
  const candidates: ReplayContent[] = [];
  const collectString = (value: string | null | undefined): void => {
    if (typeof value === 'string') candidates.push(value);
  };
  if (typeof turn.content === 'string') collectString(turn.content);
  else if (Array.isArray(turn.content)) {
    for (const channel of collectTextGroups(turn.content, chatCompletionsTextGroup).values()) candidates.push(channel.text);
  }
  collectString(turn.refusal);
  for (const field of reasoningFields) collectString(turn[field]);
  for (const value of reasoningDetails(turn)) {
    if (isJSONRecord(value) && value.type === 'reasoning.summary' && typeof value.summary === 'string') candidates.push(value.summary);
  }
  if (turn.function_call != null) collectString(turn.function_call.arguments);
  for (const call of turn.tool_calls ?? []) collectString(call.type === 'function' ? call.function.arguments : call.custom.input);
  return candidates;
};

export const verifyOpenAIChatCompletionsTurnDigest = createTurnDigestVerifier(chatTurnDigestMaterialV1);

// Our carrier uses indexed OpenRouter reasoning_details.
// https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#reasoning-details-api-shape
export const createOpenAIChatCompletionsSidecarDetails = (data: string): OpenAIChatCompletionsSidecarDetail[] =>
  [{ type: 'reasoning.encrypted', data, format: 'unknown', index: 1 }];

export const collectOpenAIChatCompletionsTextPlacements = (turn: OpenAIChatCompletionsSourceAssistantTurn): TextPlacementIndex => {
  const views: TextPlacementIndex = new Map();
  if (Array.isArray(turn.content)) collectTextPlacementIndex(collectTextGroups(turn.content, chatCompletionsTextGroup), views);
  return views;
};
