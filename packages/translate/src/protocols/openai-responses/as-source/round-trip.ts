import type { IRJSONObject, IRJSONValue } from '../../../ir/types.ts';
import type { ReplayContent } from '../../../round-trip/reference/assistant-turn.ts';
import type { EncodedRoundTripSidecar } from '../../../round-trip/resolve.ts';
import { collectTextGroups, collectTextPlacementIndex, type TextContribution, type TextPlacementIndex } from '../../../round-trip/text-groups.ts';
import { computeRoundTripTurnDigest, replayMaterialsByType, verifyRoundTripTurnDigest } from '../../../round-trip/turn-digest.ts';
import type { RoundTripTurnDigest } from '../../../round-trip/turn-digest.ts';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesInputContent, OpenAIResponsesOutputContentBlock, OpenAIResponsesOutputItemEx, OpenAIResponsesOutputReasoning } from '@floway-dev/protocols/openai-responses';

type OpenAIResponsesMessagePart = OpenAIResponsesInputContent | OpenAIResponsesOutputContentBlock;
type OpenAIResponsesMessageTextGroup = 'input_text' | 'output_text' | 'refusal';

const responsesMessageTextGroup = (part: OpenAIResponsesMessagePart): TextContribution<OpenAIResponsesMessageTextGroup> | undefined => {
  if (part.type === 'input_text' || part.type === 'output_text') return { channel: part.type, field: 'text', text: part.text };
  if (part.type === 'refusal') return { channel: part.type, field: 'refusal', text: part.refusal };
  return undefined;
};

const responsesReasoningTextGroup = <Part extends { readonly text: string }>(part: Part): TextContribution<'text'> =>
  ({ channel: 'text', field: 'text', text: part.text });

export type OpenAIResponsesAssistantTurnItem = CanonicalOpenAIResponsesInputItem | OpenAIResponsesOutputItemEx;
export type OpenAIResponsesAssistantTurn = OpenAIResponsesAssistantTurnItem[];

export type OpenAIResponsesSidecarCarrier = OpenAIResponsesOutputReasoning & { summary: []; encrypted_content: string };

type TypedReplayMaterial = IRJSONObject & { type: string };

export const isOpenAIResponsesEncryptedReasoning = (item: OpenAIResponsesAssistantTurnItem): item is Extract<OpenAIResponsesAssistantTurnItem, { type: 'reasoning' }> & { encrypted_content: string } =>
  item.type === 'reasoning' && typeof item.encrypted_content === 'string';

const responseMessageMaterials = (content: string | OpenAIResponsesMessagePart[]): [string, TypedReplayMaterial[]][] => {
  if (typeof content === 'string') return [['output_text', [{ type: 'output_text', text: content }]]];
  const channels = collectTextGroups(content, responsesMessageTextGroup);
  const other: TypedReplayMaterial[] = [];
  for (const part of content) if (responsesMessageTextGroup(part) === undefined) other.push({ type: part.type });
  return replayMaterialsByType([
    ...[...channels].map(([type, channel]): TypedReplayMaterial => type === 'refusal' ? { type, refusal: channel.text } : { type, text: channel.text }),
    ...other,
  ]);
};

const concatenateResponseText = <Part extends object & { readonly text: string }>(parts: readonly Part[]): string =>
  collectTextGroups(parts, responsesReasoningTextGroup).get('text')?.text ?? '';

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

export const collectOpenAIResponsesReplayContents = (turn: OpenAIResponsesAssistantTurn): ReplayContent[] => {
  const candidates: ReplayContent[] = [];
  for (const item of turn) {
    if (item.type === 'message') {
      if (typeof item.content === 'string') candidates.push(item.content);
      else for (const channel of collectTextGroups(item.content, responsesMessageTextGroup).values()) candidates.push(channel.text);
    } else if (item.type === 'reasoning') {
      const summary = collectTextGroups(item.summary, responsesReasoningTextGroup).get('text');
      const content = collectTextGroups(item.content ?? [], responsesReasoningTextGroup).get('text');
      if (summary !== undefined) candidates.push(summary.text);
      if (content !== undefined) candidates.push(content.text);
    } else if (item.type === 'function_call') candidates.push(item.arguments);
    else if (item.type === 'custom_tool_call') candidates.push(item.input);
    else if (item.type === 'image_generation_call' && typeof item.result === 'string') candidates.push(item.result);
  }
  return candidates;
};

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

export const collectOpenAIResponsesTextViews = (turn: OpenAIResponsesAssistantTurn): TextPlacementIndex => {
  const views: TextPlacementIndex = new Map();
  for (const item of turn) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      collectTextPlacementIndex(collectTextGroups(item.content, responsesMessageTextGroup), views);
    } else if (item.type === 'reasoning') {
      collectTextPlacementIndex(collectTextGroups(item.summary, responsesReasoningTextGroup), views);
      if (item.content !== undefined) collectTextPlacementIndex(collectTextGroups(item.content, responsesReasoningTextGroup), views);
    }
  }
  return views;
};
