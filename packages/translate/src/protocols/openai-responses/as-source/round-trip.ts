import type { IRJSONObject, IRJSONValue } from '../../../ir/types.ts';
import { replayMaterialsByType, verifyRoundTripReplayCheck, type RoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripAssistantTurnInspection } from '../../../round-trip/replay.ts';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesInputContent, OpenAIResponsesOutputContentBlock, OpenAIResponsesOutputItemEx } from '@floway-dev/protocols/openai-responses';

export type OpenAIResponsesAssistantTurnItem = CanonicalOpenAIResponsesInputItem | OpenAIResponsesOutputItemEx;
export type OpenAIResponsesAssistantTurn = OpenAIResponsesAssistantTurnItem[];

type TypedReplayMaterial = IRJSONObject & { type: string };

export const isOpenAIResponsesEncryptedReasoning = (item: OpenAIResponsesAssistantTurnItem): item is Extract<OpenAIResponsesAssistantTurnItem, { type: 'reasoning' }> & { encrypted_content: string } =>
  item.type === 'reasoning' && typeof item.encrypted_content === 'string';

const responseMessagePartMaterial = (part: OpenAIResponsesInputContent | OpenAIResponsesOutputContentBlock): TypedReplayMaterial => {
  if (part.type === 'input_text' || part.type === 'output_text') return { type: part.type, text: part.text };
  if (part.type === 'refusal') return { type: part.type, refusal: part.refusal };
  return { type: part.type };
};

const replayItemStatus = (item: OpenAIResponsesAssistantTurnItem): { status?: string | null } =>
  'status' in item && item.status !== undefined ? { status: item.status } : {};

const replayItemMaterial = (item: OpenAIResponsesAssistantTurnItem): TypedReplayMaterial => {
  if (item.type === 'reasoning') return {
    type: item.type,
    ...replayItemStatus(item),
    summary: item.summary.map(part => ({ type: part.type, text: part.text })),
    content: item.content?.map(part => ({ type: part.type, text: part.text })) ?? [],
  };
  if (item.type === 'message') return {
    type: item.type,
    ...replayItemStatus(item),
    content: replayMaterialsByType(typeof item.content === 'string'
      ? [{ type: 'output_text', text: item.content }]
      : item.content.map(responseMessagePartMaterial)),
  };
  if (item.type === 'function_call') return {
    type: item.type,
    ...replayItemStatus(item),
    call_id: item.call_id,
    name: item.name,
    ...(item.namespace === undefined ? {} : { namespace: item.namespace }),
    arguments: item.arguments,
  };
  if (item.type === 'custom_tool_call') return {
    type: item.type,
    ...replayItemStatus(item),
    call_id: item.call_id,
    name: item.name,
    ...(item.namespace === undefined ? {} : { namespace: item.namespace }),
    input: item.input,
  };
  if (item.type === 'image_generation_call') return item.result === undefined
    ? { type: item.type, ...replayItemStatus(item) }
    : { type: item.type, ...replayItemStatus(item), result: item.result };
  return { type: item.type, ...replayItemStatus(item) };
};

const responsesReplayCheckMaterialV1 = (turn: OpenAIResponsesAssistantTurn): IRJSONValue => replayMaterialsByType(turn.map(replayItemMaterial));

export const inspectOpenAIResponsesAssistantTurn = (turn: OpenAIResponsesAssistantTurn): RoundTripAssistantTurnInspection<OpenAIResponsesAssistantTurn> => {
  const sidecars: string[] = [];
  const assistantTurn = turn.flatMap(item => {
    if (!isOpenAIResponsesEncryptedReasoning(item)) return [item];
    sidecars.push(item.encrypted_content);
    const { encrypted_content: _encryptedContent, ...body } = item;
    return item.summary.length === 0 && (item.content === undefined || item.content.length === 0) ? [] : [body];
  });
  return {
    sidecars,
    turn: assistantTurn,
  };
};

export const verifyOpenAIResponsesReplayCheck = (
  turn: OpenAIResponsesAssistantTurn,
  replayCheck: RoundTripReplayCheck,
): Promise<boolean> => {
  switch (replayCheck.version) {
  case 1: return verifyRoundTripReplayCheck(responsesReplayCheckMaterialV1(turn), replayCheck);
  default: return Promise.resolve(false);
  }
};
