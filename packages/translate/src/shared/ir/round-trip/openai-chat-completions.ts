
import type { IRJSONValue } from '../ir.ts';
import type { IRPath } from '../stream.ts';
import type { IATReference, IRReplayCandidate, OpenAIChatCompletionsThinAssistantTurn } from '../thin-types.ts';
import { createIRRoundTripReplayCheck, verifyIRRoundTripReplayCheck } from './replay-check.ts';
import { replaceIRRoundTripReferences } from './thin-builder.ts';
import type { IRRoundTripAssistantTurnInspection, IRRoundTripConversationTurn, IRRoundTripReplayCheck } from './types.ts';
import type {
  OpenAIChatCompletionsAssistantMessageEx,
  OpenAIChatCompletionsAssistantOutputMessageEx,
  OpenAIChatCompletionsMessage,
  OpenAIChatCompletionsReasoningItem,
  OpenAIChatCompletionsToolCallEx,
} from '@floway-dev/protocols/openai-chat-completions';

export const OPENAI_CHAT_COMPLETIONS_REPLAY_CHECK_VERSION = 1;

export type OpenAIChatCompletionsConversationMessage = OpenAIChatCompletionsMessage | OpenAIChatCompletionsAssistantMessageEx;
export type OpenAIChatCompletionsAssistantTurn = OpenAIChatCompletionsAssistantMessageEx;
export type OpenAIChatCompletionsConversationTurn = IRRoundTripConversationTurn<'assistant' | 'bare', OpenAIChatCompletionsConversationMessage>;

export type OpenAIChatCompletionsReasoningDetailsCarrier =
  | { type: 'reasoning.summary'; summary: string; format: 'unknown'; index: 0 }
  | { type: 'reasoning.encrypted'; data: string; format: 'unknown'; index: 1 };

const asRecord = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const reasoningDetails = (turn: OpenAIChatCompletionsAssistantTurn): unknown[] => Array.isArray(turn.reasoning_details) ? turn.reasoning_details : [];

const readReasoningDetailsSummary = (turn: OpenAIChatCompletionsAssistantTurn): string[] => reasoningDetails(turn).flatMap(value => {
  const item = asRecord(value);
  return item?.type === 'reasoning.summary' && typeof item.summary === 'string' ? [item.summary] : [];
});

const reasoningDetailsMaterial = (turn: OpenAIChatCompletionsAssistantTurn): unknown[] => reasoningDetails(turn).flatMap(value => {
  const item = asRecord(value);
  if (item?.type === 'reasoning.summary' && typeof item.summary === 'string') {
    return [{ type: item.type, summary: item.summary, ...(Object.hasOwn(item, 'format') ? { format: item.format } : {}) }];
  }
  if (item?.type === 'reasoning.encrypted' && typeof item.data === 'string') {
    return [{ type: item.type, ...(Object.hasOwn(item, 'format') ? { format: item.format } : {}) }];
  }
  return [];
});

const readReasoningItemSummaries = (turn: OpenAIChatCompletionsAssistantTurn): string[] => {
  if (!Array.isArray(turn.reasoning_items)) return [];
  return (turn.reasoning_items as OpenAIChatCompletionsReasoningItem[]).flatMap(item => {
    if (item.type !== 'reasoning') return [];
    return (item.summary ?? []).map(summary => summary.text);
  });
};

const reasoningDetailSidecars = (turn: OpenAIChatCompletionsAssistantTurn): string[] => reasoningDetails(turn).flatMap(value => {
  const item = asRecord(value);
  return item?.type === 'reasoning.encrypted' && typeof item.data === 'string' ? [item.data] : [];
});

const messageContentMaterial = (turn: OpenAIChatCompletionsAssistantTurn): unknown => {
  if (typeof turn.content === 'string' || turn.content === null || turn.content === undefined) return turn.content;
  return turn.content.map(part => part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'refusal', refusal: part.refusal });
};

const toolCallMaterial = (call: OpenAIChatCompletionsToolCallEx): IRJSONValue => call.type === 'function'
  ? { type: 'function', id: call.id, name: call.function.name, arguments: call.function.arguments }
  : { type: 'custom', id: call.id, name: call.custom.name, input: call.custom.input };

const reasoningTextMaterial = (turn: OpenAIChatCompletionsAssistantTurn): unknown[] => {
  const fields = ['reasoning', 'reasoning_text', 'reasoning_content'] as const;
  return fields.flatMap(field => Object.hasOwn(turn, field) ? [{ field, value: turn[field] }] : []);
};

const chatReplayCheckMaterial = (turn: OpenAIChatCompletionsAssistantTurn): unknown => ({
  role: turn.role,
  ...(Object.hasOwn(turn, 'content') ? { content: messageContentMaterial(turn) } : {}),
  ...(Object.hasOwn(turn, 'name') ? { name: turn.name } : {}),
  ...(Object.hasOwn(turn, 'refusal') ? { refusal: turn.refusal } : {}),
  ...(Object.hasOwn(turn, 'audio') ? { audio: turn.audio == null ? turn.audio : { id: turn.audio.id } } : {}),
  ...(turn.function_call != null
    ? { function_call: { name: turn.function_call.name, arguments: turn.function_call.arguments } }
    : { function_call: turn.function_call }),
  ...(turn.tool_calls !== undefined ? { tool_calls: turn.tool_calls.map(toolCallMaterial) } : {}),
  reasoningText: reasoningTextMaterial(turn),
  reasoningDetails: reasoningDetailsMaterial(turn),
  reasoningItems: readReasoningItemSummaries(turn),
});

const collectString = (candidates: IRReplayCandidate[], value: unknown): void => {
  if (typeof value === 'string') candidates.push(value);
};

export const partitionOpenAIChatCompletionsTurns = (messages: readonly OpenAIChatCompletionsConversationMessage[]): OpenAIChatCompletionsConversationTurn[] => messages.map(message => ({
  role: message.role === 'assistant' ? 'assistant' : 'bare',
  items: [message],
}));

export const inspectOpenAIChatCompletionsAssistantTurn = (turn: OpenAIChatCompletionsAssistantTurn): IRRoundTripAssistantTurnInspection => {
  const candidates: IRReplayCandidate[] = [];
  if (typeof turn.content === 'string') collectString(candidates, turn.content);
  else if (Array.isArray(turn.content)) for (const part of turn.content) collectString(candidates, part.type === 'text' ? part.text : part.refusal);
  collectString(candidates, turn.refusal);
  for (const field of ['reasoning', 'reasoning_text', 'reasoning_content'] as const) collectString(candidates, turn[field]);
  candidates.push(...readReasoningDetailsSummary(turn), ...readReasoningItemSummaries(turn));
  if (turn.function_call !== undefined && turn.function_call !== null) collectString(candidates, turn.function_call.arguments);
  for (const call of turn.tool_calls ?? []) collectString(candidates, call.type === 'function' ? call.function.arguments : call.custom.input);
  return {
    sidecars: reasoningDetailSidecars(turn),
    candidates,
    checkMaterial: chatReplayCheckMaterial(turn),
  };
};

export const createOpenAIChatCompletionsReplayCheck = async (turn: OpenAIChatCompletionsAssistantTurn): Promise<IRRoundTripReplayCheck | undefined> => {
  const inspection = inspectOpenAIChatCompletionsAssistantTurn(turn);
  return inspection.sidecars.length === 1
    ? await createIRRoundTripReplayCheck(inspection.checkMaterial, OPENAI_CHAT_COMPLETIONS_REPLAY_CHECK_VERSION)
    : undefined;
};

export const verifyOpenAIChatCompletionsReplayCheck = async (turn: OpenAIChatCompletionsAssistantTurn, replayCheck: IRRoundTripReplayCheck): Promise<boolean> => {
  const inspection = inspectOpenAIChatCompletionsAssistantTurn(turn);
  return await (inspection.sidecars.length === 1 && verifyIRRoundTripReplayCheck(inspection.checkMaterial, replayCheck, OPENAI_CHAT_COMPLETIONS_REPLAY_CHECK_VERSION));
};

export const cleanOpenAIChatCompletionsAssistantTurn = (turn: OpenAIChatCompletionsAssistantTurn): OpenAIChatCompletionsAssistantTurn => {
  const content = Array.isArray(turn.content) ? turn.content.map(part => part.type === 'text'
    ? { type: 'text' as const, text: part.text }
    : { type: 'refusal' as const, refusal: part.refusal }) : turn.content;
  const functionCall = turn.function_call == null ? turn.function_call : { name: turn.function_call.name, arguments: turn.function_call.arguments };
  const toolCalls = turn.tool_calls?.map(call => call.type === 'function'
    ? { id: call.id, type: 'function' as const, function: { name: call.function.name, arguments: call.function.arguments } }
    : { id: call.id, type: 'custom' as const, custom: { name: call.custom.name, input: call.custom.input } });
  return {
    role: turn.role,
    ...(Object.hasOwn(turn, 'content') ? { content } : {}),
    ...(Object.hasOwn(turn, 'name') ? { name: turn.name } : {}),
    ...(Object.hasOwn(turn, 'refusal') ? { refusal: turn.refusal } : {}),
    ...(Object.hasOwn(turn, 'audio') ? { audio: turn.audio === null || turn.audio === undefined ? turn.audio : { id: turn.audio.id } } : {}),
    ...(Object.hasOwn(turn, 'function_call') ? { function_call: functionCall } : {}),
    ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
  };
};

// OpenRouter reasoning_details uses an indexed summary/encrypted pair.
// https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#reasoning-details
export const createOpenAIChatCompletionsSidecarCarrier = (data: string, summary?: string): OpenAIChatCompletionsReasoningDetailsCarrier[] => [
  ...(summary === undefined ? [] : [{ type: 'reasoning.summary' as const, summary, format: 'unknown' as const, index: 0 as const }]),
  { type: 'reasoning.encrypted', data, format: 'unknown', index: 1 },
];

const chatThinReferencePaths = (turn: OpenAIChatCompletionsAssistantTurn): IRPath[] => {
  const paths: IRPath[] = [];
  if (typeof turn.content === 'string') paths.push(['content']);
  else if (Array.isArray(turn.content)) turn.content.forEach((part, index) => paths.push(['content', index, part.type === 'text' ? 'text' : 'refusal']));
  if (typeof turn.refusal === 'string') paths.push(['refusal']);
  for (const field of ['reasoning', 'reasoning_text', 'reasoning_content'] as const) if (typeof turn[field] === 'string') paths.push([field]);
  if (Array.isArray(turn.reasoning_items)) turn.reasoning_items.forEach((value, itemIndex) => {
    const item = asRecord(value);
    if (item !== undefined && Array.isArray(item.summary)) item.summary.forEach((summaryValue, summaryIndex) => {
      if (typeof asRecord(summaryValue)?.text === 'string') paths.push(['reasoning_items', itemIndex, 'summary', summaryIndex, 'text']);
    });
  });
  if (typeof turn.function_call?.arguments === 'string') paths.push(['function_call', 'arguments']);
  turn.tool_calls?.forEach((call, index) => paths.push(['tool_calls', index, call.type === 'function' ? 'function' : 'custom', call.type === 'function' ? 'arguments' : 'input']));
  return paths;
};

export const buildOpenAIChatCompletionsThinAssistantTurn = (
  outputTurn: OpenAIChatCompletionsAssistantOutputMessageEx,
  referencesByProtocolPath: ReadonlyMap<string, IATReference>,
): OpenAIChatCompletionsThinAssistantTurn<IATReference> => {
  const { annotations: _annotations, audio, ...message } = outputTurn;
  const assistantTurn: OpenAIChatCompletionsAssistantTurn = {
    ...message,
    ...(Object.hasOwn(outputTurn, 'audio') ? { audio: audio === null || audio === undefined ? audio : { id: audio.id } } : {}),
  };
  return replaceIRRoundTripReferences(assistantTurn, referencesByProtocolPath, chatThinReferencePaths(assistantTurn)) as OpenAIChatCompletionsThinAssistantTurn<IATReference>;
};
