import { isEncryptedReasoningDetail } from './reasoning-details.ts';
import type { AffinityCodec, DecodedAffinityBlob } from '../../shared/affinity/carrier.ts';
import { type AffinityAnalysis, type AffinityCandidate, isIncompatibleAffinityProjection, projectOptionalAffinityBlob } from '../../shared/affinity/selection.ts';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

const reasoningFields = ['reasoning_text', 'reasoning_content', 'reasoning', 'reasoning_details', 'reasoning_items', 'thinking_blocks'] as const;

interface MessageLocation {
  readonly index: number;
  readonly opaque: DecodedAffinityBlob | undefined;
  readonly details: readonly (readonly [number, DecodedAffinityBlob])[];
}

export interface OpenAIChatCompletionsAffinityAnalysis extends AffinityAnalysis {
  readonly locations: readonly MessageLocation[];
}

export const decodeOpenAIChatCompletionsAffinity = async (
  payload: OpenAIChatCompletionsPayloadEx,
  codec: Pick<AffinityCodec, 'unwrap'>,
): Promise<OpenAIChatCompletionsAffinityAnalysis> => {
  const locations: MessageLocation[] = [];
  for (const [index, message] of payload.messages.entries()) {
    if (message.role !== 'assistant') continue;
    const extensions = message as OpenAIChatCompletionsAssistantMessageEx;
    const opaque = typeof extensions.reasoning_opaque === 'string'
      ? await codec.unwrap(extensions.reasoning_opaque, 'openai-chat-completions.reasoning_opaque')
      : undefined;
    const details: Array<readonly [number, DecodedAffinityBlob]> = [];
    if (Array.isArray(extensions.reasoning_details)) {
      for (const [detailIndex, detail] of extensions.reasoning_details.entries()) {
        if (!isEncryptedReasoningDetail(detail)) continue;
        details.push([detailIndex, await codec.unwrap(detail.data, 'openai-chat-completions.reasoning_details.reasoning.encrypted.data')]);
      }
    }
    if (opaque !== undefined || details.length > 0) locations.push({ index, opaque, details });
  }

  return { requiredTargets: [], locations };
};

const projectedMessage = (
  { index, opaque, details }: MessageLocation, candidate: AffinityCandidate, payload: OpenAIChatCompletionsPayloadEx,
) => {
  const opaqueProjection = opaque === undefined ? undefined : projectOptionalAffinityBlob(opaque, candidate);
  const detailProjections = new Map(details.map(([detailIndex, blob]) => [detailIndex, projectOptionalAffinityBlob(blob, candidate)]));
  const projections = [...detailProjections.values()];
  if (opaqueProjection !== undefined) projections.push(opaqueProjection);
  const dropsReasoning = projections.some(isIncompatibleAffinityProjection);
  const message = payload.messages[index] as OpenAIChatCompletionsAssistantMessageEx;
  const hasReasoning = reasoningFields.some(field => {
    const value = message[field];
    return value != null && value !== '' && (!Array.isArray(value) || value.length > 0);
  });
  return {
    index, opaqueProjection, detailProjections, dropsReasoning,
    degrades: (dropsReasoning && hasReasoning) || projections.some(projection => projection.kind === 'remove' && projection.degrades),
    preferred: projections.every(projection => projection.preferred),
  };
};

const materializeMessages = (
  payload: OpenAIChatCompletionsPayloadEx, projections: readonly ReturnType<typeof projectedMessage>[],
): OpenAIChatCompletionsPayloadEx => {
  if (projections.length === 0) return payload;
  const messages = [...payload.messages];
  for (const { index, opaqueProjection, detailProjections, dropsReasoning } of projections) {
    const message = { ...messages[index] } as OpenAIChatCompletionsAssistantMessageEx;
    messages[index] = message;
    if (dropsReasoning) {
      delete message.reasoning_opaque;
      for (const field of reasoningFields) delete message[field];
      continue;
    }
    if (opaqueProjection?.kind === 'preserve') message.reasoning_opaque = opaqueProjection.value;
    else if (opaqueProjection?.kind === 'remove') delete message.reasoning_opaque;
    if (detailProjections.size === 0) continue;
    if (!Array.isArray(message.reasoning_details)) throw new Error('OpenAI Chat Completions affinity expected reasoning details');
    const details = message.reasoning_details.flatMap((detail, detailIndex) => {
      const projection = detailProjections.get(detailIndex);
      if (projection === undefined) return [detail];
      if (projection.kind === 'remove') return [];
      if (!isEncryptedReasoningDetail(detail)) throw new Error(`Recorded encrypted reasoning detail is missing at index ${detailIndex}`);
      return [{ ...detail, data: projection.value }];
    });
    if (details.length === 0) delete message.reasoning_details;
    else message.reasoning_details = details;
  }
  return { ...payload, messages };
};

const planAffinity = (
  analysis: OpenAIChatCompletionsAffinityAnalysis, candidate: AffinityCandidate, payload: OpenAIChatCompletionsPayloadEx,
) => {
  const messages = analysis.locations.map(location => projectedMessage(location, candidate, payload));
  return {
    messages,
    score: {
      kind: 'accepted' as const,
      degrades: messages.some(message => message.degrades),
      preferred: messages.every(message => message.preferred),
    },
  };
};

export const scoreOpenAIChatCompletionsAffinity = (...args: Parameters<typeof planAffinity>) => planAffinity(...args).score;

export const evaluateOpenAIChatCompletionsAffinity = (...[analysis, candidate, payload]: Parameters<typeof planAffinity>) => {
  const { score, messages } = planAffinity(analysis, candidate, payload);
  return { ...score, payload: materializeMessages(payload, messages) };
};
