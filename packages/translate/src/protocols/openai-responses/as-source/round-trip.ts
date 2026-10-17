import type { IRJSONObject, IRJSONValue } from '../../../ir/types.ts';
import { computeRoundTripReplayCheck, replayMaterialsByType, verifyRoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripReplayCheck } from '../../../round-trip/replay-check.ts';
import type { RoundTripSidecarCandidate } from '../../../round-trip/replay.ts';
import { collectTextChannels, collectTextChannelViews, type TextChannelProjection, type TextChannelViews } from '../../../round-trip/text-channels.ts';
import type { ReplayCandidate } from '../../../round-trip/thin/assistant-turn.ts';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesInputContent, OpenAIResponsesOutputContentBlock, OpenAIResponsesOutputItemEx, OpenAIResponsesOutputReasoning } from '@floway-dev/protocols/openai-responses';

type OpenAIResponsesMessagePart = OpenAIResponsesInputContent | OpenAIResponsesOutputContentBlock;
type OpenAIResponsesMessageTextChannel = 'input_text' | 'output_text' | 'refusal';

const responsesMessageTextChannel = (part: OpenAIResponsesMessagePart): TextChannelProjection<OpenAIResponsesMessageTextChannel> | undefined => {
  if (part.type === 'input_text' || part.type === 'output_text') return { channel: part.type, field: 'text', text: part.text };
  if (part.type === 'refusal') return { channel: part.type, field: 'refusal', text: part.refusal };
  return undefined;
};

const responsesReasoningTextChannel = <Part extends { readonly text: string }>(part: Part): TextChannelProjection<'text'> =>
  ({ channel: 'text', field: 'text', text: part.text });

export const OPENAI_RESPONSES_REPLAY_CHECK_VERSION = 1;

export type OpenAIResponsesAssistantTurnItem = CanonicalOpenAIResponsesInputItem | OpenAIResponsesOutputItemEx;
export type OpenAIResponsesAssistantTurn = OpenAIResponsesAssistantTurnItem[];

export type OpenAIResponsesSidecarCarrier = OpenAIResponsesOutputReasoning & { summary: []; encrypted_content: string };

type TypedReplayMaterial = IRJSONObject & { type: string };

export const isOpenAIResponsesEncryptedReasoning = (item: OpenAIResponsesAssistantTurnItem): item is Extract<OpenAIResponsesAssistantTurnItem, { type: 'reasoning' }> & { encrypted_content: string } =>
  item.type === 'reasoning' && typeof item.encrypted_content === 'string';

const responseMessageMaterials = (content: string | OpenAIResponsesMessagePart[]): [string, TypedReplayMaterial[]][] => {
  if (typeof content === 'string') return [['output_text', [{ type: 'output_text', text: content }]]];
  const channels = collectTextChannels(content, responsesMessageTextChannel);
  const other: TypedReplayMaterial[] = [];
  for (const part of content) if (responsesMessageTextChannel(part) === undefined) other.push({ type: part.type });
  return replayMaterialsByType([
    ...[...channels].map(([type, channel]): TypedReplayMaterial => type === 'refusal' ? { type, refusal: channel.text } : { type, text: channel.text }),
    ...other,
  ]);
};

const concatenateResponseText = <Part extends object & { readonly text: string }>(parts: readonly Part[]): string =>
  collectTextChannels(parts, responsesReasoningTextChannel).get('text')?.text ?? '';

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
      else for (const channel of collectTextChannels(item.content, responsesMessageTextChannel).values()) candidates.push(channel.text);
    } else if (item.type === 'reasoning') {
      const summary = collectTextChannels(item.summary, responsesReasoningTextChannel).get('text');
      const content = collectTextChannels(item.content ?? [], responsesReasoningTextChannel).get('text');
      if (summary !== undefined) candidates.push(summary.text);
      if (content !== undefined) candidates.push(content.text);
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

export const collectOpenAIResponsesTextViews = (turn: OpenAIResponsesAssistantTurn): TextChannelViews => {
  const views: TextChannelViews = new Map();
  for (const item of turn) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      collectTextChannelViews(collectTextChannels(item.content, responsesMessageTextChannel), views);
    } else if (item.type === 'reasoning') {
      collectTextChannelViews(collectTextChannels(item.summary, responsesReasoningTextChannel), views);
      if (item.content !== undefined) collectTextChannelViews(collectTextChannels(item.content, responsesReasoningTextChannel), views);
    }
  }
  return views;
};
