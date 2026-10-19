import type { IRJSONObject, IRJSONValue } from '../../../ir/types.ts';
import type { EncodedRoundTripSidecar } from '../../../round-trip/resolve.ts';
import { computeRoundTripTurnDigest, replayMaterialsByType, verifyRoundTripTurnDigest } from '../../../round-trip/turn-digest.ts';
import type { RoundTripTurnDigest } from '../../../round-trip/turn-digest.ts';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesInputContent, OpenAIResponsesOutputContentBlock, OpenAIResponsesOutputItemEx, OpenAIResponsesOutputReasoning } from '@floway-dev/protocols/openai-responses';

export type OpenAIResponsesAssistantTurnItem = CanonicalOpenAIResponsesInputItem | OpenAIResponsesOutputItemEx;
export type OpenAIResponsesAssistantTurn = OpenAIResponsesAssistantTurnItem[];

export type OpenAIResponsesSidecarCarrier = OpenAIResponsesOutputReasoning & { summary: []; encrypted_content: string };

type TypedReplayMaterial = IRJSONObject & { type: string };

export const isOpenAIResponsesEncryptedReasoning = (item: OpenAIResponsesAssistantTurnItem): item is Extract<OpenAIResponsesAssistantTurnItem, { type: 'reasoning' }> & { encrypted_content: string } =>
  item.type === 'reasoning' && typeof item.encrypted_content === 'string';

const responseMessageMaterials = (content: string | Array<OpenAIResponsesInputContent | OpenAIResponsesOutputContentBlock>): [string, TypedReplayMaterial[]][] => {
  if (typeof content === 'string') return [['output_text', [{ type: 'output_text', text: content }]]];
  const textByType = new Map<'input_text' | 'output_text' | 'refusal', string>();
  const other: TypedReplayMaterial[] = [];
  for (const part of content) {
    if (part.type === 'input_text' || part.type === 'output_text') {
      textByType.set(part.type, (textByType.get(part.type) ?? '') + part.text);
    } else if (part.type === 'refusal') {
      textByType.set(part.type, (textByType.get(part.type) ?? '') + part.refusal);
    } else other.push({ type: part.type });
  }
  return replayMaterialsByType([
    ...[...textByType].map(([type, text]): TypedReplayMaterial => type === 'refusal' ? { type, refusal: text } : { type, text }),
    ...other,
  ]);
};

const concatenateResponseText = <Part extends { readonly text: string }>(parts: readonly Part[]): string => parts.map(part => part.text).join('');

const replayItemStatus = (item: OpenAIResponsesAssistantTurnItem): { status?: string | null } =>
  'status' in item && item.status !== undefined ? { status: item.status } : {};

const replayItemMaterial = (item: OpenAIResponsesAssistantTurnItem): TypedReplayMaterial => {
  if (item.type === 'reasoning') return {
    type: item.type,
    ...replayItemStatus(item),
    summary: concatenateResponseText(item.summary),
    content: concatenateResponseText(item.content ?? []),
  };
  if (item.type === 'message') return {
    type: item.type,
    ...replayItemStatus(item),
    content: responseMessageMaterials(item.content),
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

const responsesTurnDigestMaterialV1 = (turn: OpenAIResponsesAssistantTurn): IRJSONValue => replayMaterialsByType(turn.map(replayItemMaterial));

export const findOpenAIResponsesSidecarCarriers = (turn: OpenAIResponsesAssistantTurn): EncodedRoundTripSidecar<OpenAIResponsesAssistantTurn>[] =>
  turn.flatMap((item, itemIndex) => !isOpenAIResponsesEncryptedReasoning(item) ? [] : [{
    data: item.encrypted_content,
    withoutSidecar: () => {
      const { encrypted_content: _encryptedContent, ...body } = item;
      return turn.flatMap((value, index) => index !== itemIndex ? [value]
        : item.summary.length === 0 && (item.content == null || item.content.length === 0) ? [] : [body]);
    },
  }]);

export const computeOpenAIResponsesTurnDigest = (turn: OpenAIResponsesAssistantTurn): Promise<RoundTripTurnDigest> =>
  computeRoundTripTurnDigest(responsesTurnDigestMaterialV1(turn));

export const verifyOpenAIResponsesTurnDigest = (
  turn: OpenAIResponsesAssistantTurn,
  sourceTurnDigest: RoundTripTurnDigest,
  version: number,
): Promise<boolean> => {
  switch (version) {
  case 1: return verifyRoundTripTurnDigest(responsesTurnDigestMaterialV1(turn), sourceTurnDigest);
  default: return Promise.resolve(false);
  }
};

export const createOpenAIResponsesSidecarCarrier = (id: string, data: string): OpenAIResponsesSidecarCarrier => ({
  type: 'reasoning',
  id,
  summary: [],
  encrypted_content: data,
});
