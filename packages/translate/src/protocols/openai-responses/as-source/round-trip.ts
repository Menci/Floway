import type { IRJSONObject, IRJSONValue } from '../../../ir/types.ts';
import { computeRoundTripReplayCheck, replayMaterialsByType, verifyRoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripSidecarCandidate } from '../../../round-trip/replay.ts';
import { canonicalTextParts, collectCanonicalTextViews, isPureTextPart, type CanonicalTextView, type PureTextPart } from '../../../round-trip/text-parts.ts';
import type { ReplayCandidate } from '../../../round-trip/thin/assistant-turn.ts';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesInputContent, OpenAIResponsesOutputContentBlock, OpenAIResponsesOutputItemEx, OpenAIResponsesOutputReasoning } from '@floway-dev/protocols/openai-responses';

type OpenAIResponsesReplayPart = OpenAIResponsesInputContent | OpenAIResponsesOutputContentBlock
  | OpenAIResponsesOutputReasoning['summary'][number] | NonNullable<OpenAIResponsesOutputReasoning['content']>[number];

const isOpenAIResponsesPureTextPart = <Part extends OpenAIResponsesReplayPart>(part: Part): part is Part & PureTextPart =>
  isPureTextPart(part, ['input_text', 'output_text', 'summary_text', 'reasoning_text'], ['annotations', 'logprobs']);

export const OPENAI_RESPONSES_REPLAY_CHECK_VERSION = 1;

export type OpenAIResponsesAssistantTurnItem = CanonicalOpenAIResponsesInputItem | OpenAIResponsesOutputItemEx;
export type OpenAIResponsesAssistantTurn = OpenAIResponsesAssistantTurnItem[];

export type OpenAIResponsesSidecarCarrier = OpenAIResponsesOutputReasoning & { summary: []; encrypted_content: string };

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
    summary: canonicalTextParts(item.summary, isOpenAIResponsesPureTextPart).map(part => ({ type: part.type, text: part.text })),
    content: canonicalTextParts(item.content ?? [], isOpenAIResponsesPureTextPart).map(part => ({ type: part.type, text: part.text })),
  };
  if (item.type === 'message') return {
    type: item.type,
    ...replayItemStatus(item),
    content: replayMaterialsByType(typeof item.content === 'string'
      ? [{ type: 'output_text', text: item.content }]
      : canonicalTextParts(item.content, isOpenAIResponsesPureTextPart).map(responseMessagePartMaterial)),
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

export const inspectOpenAIResponsesAssistantTurn = (turn: OpenAIResponsesAssistantTurn): RoundTripSidecarCandidate<OpenAIResponsesAssistantTurn>[] =>
  turn.flatMap((item, itemIndex) => !isOpenAIResponsesEncryptedReasoning(item) ? [] : [{
    data: item.encrypted_content,
    withoutSidecar: () => {
      const { encrypted_content: _encryptedContent, ...body } = item;
      return turn.flatMap((value, index) => index !== itemIndex ? [value]
        : item.summary.length === 0 && (item.content === undefined || item.content.length === 0) ? [] : [body]);
    },
  }]);

export const computeOpenAIResponsesReplayCheck = (turn: OpenAIResponsesAssistantTurn): Promise<RoundTripReplayCheck> =>
  computeRoundTripReplayCheck(OPENAI_RESPONSES_REPLAY_CHECK_VERSION, responsesReplayCheckMaterialV1(turn));

export const collectOpenAIResponsesReplayCandidates = (turn: OpenAIResponsesAssistantTurn): ReplayCandidate[] => {
  const candidates: ReplayCandidate[] = [];
  for (const item of turn) {
    if (item.type === 'message') {
      if (typeof item.content === 'string') candidates.push(item.content);
      else for (const part of canonicalTextParts(item.content, isOpenAIResponsesPureTextPart)) {
        if (part.type === 'input_text' || part.type === 'output_text') candidates.push(part.text);
        else if (part.type === 'refusal') candidates.push(part.refusal);
      }
    } else if (item.type === 'reasoning') {
      for (const part of canonicalTextParts(item.summary, isOpenAIResponsesPureTextPart)) candidates.push(part.text);
      for (const part of canonicalTextParts(item.content ?? [], isOpenAIResponsesPureTextPart)) candidates.push(part.text);
    } else if (item.type === 'function_call') candidates.push(item.arguments);
    else if (item.type === 'custom_tool_call') candidates.push(item.input);
    else if (item.type === 'image_generation_call' && typeof item.result === 'string') candidates.push(item.result);
  }
  return candidates;
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

export const createOpenAIResponsesSidecarCarrier = (id: string, data: string): OpenAIResponsesSidecarCarrier => ({
  type: 'reasoning',
  id,
  summary: [],
  encrypted_content: data,
});

export const collectOpenAIResponsesTextViews = (turn: OpenAIResponsesAssistantTurn): Map<object, CanonicalTextView> => {
  const views = new Map<object, CanonicalTextView>();
  for (const item of turn) {
    if (item.type === 'message' && Array.isArray(item.content)) collectCanonicalTextViews(item.content, isOpenAIResponsesPureTextPart, views);
    else if (item.type === 'reasoning') {
      collectCanonicalTextViews(item.summary, isOpenAIResponsesPureTextPart, views);
      if (item.content !== undefined) collectCanonicalTextViews(item.content, isOpenAIResponsesPureTextPart, views);
    }
  }
  return views;
};
