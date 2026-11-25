import { isEncryptedReasoningDetail } from './reasoning-details.ts';
import { type AffinityCodec, type AffinityRequestAnalysis, type DecodedAffinityBlob, defineAffinityRequest, isIncompatibleAffinityProjection, projectOptionalAffinityBlob } from '../../shared/affinity/index.ts';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

const reasoningFields = ['reasoning_text', 'reasoning_content', 'reasoning', 'reasoning_details', 'reasoning_items', 'thinking_blocks'] as const;

export const analyzeOpenAIChatCompletionsAffinity = async (
  payload: OpenAIChatCompletionsPayloadEx,
  codec: AffinityCodec,
): Promise<AffinityRequestAnalysis<OpenAIChatCompletionsPayloadEx>> => {
  const locations: Array<{ index: number; opaque: DecodedAffinityBlob | undefined; details: Map<number, DecodedAffinityBlob> }> = [];
  for (const [index, message] of payload.messages.entries()) {
    if (message.role !== 'assistant') continue;
    const extensions = message as OpenAIChatCompletionsAssistantMessageEx;
    const opaque = typeof extensions.reasoning_opaque === 'string'
      ? await codec.unwrap(extensions.reasoning_opaque, 'openai-chat-completions.reasoning_opaque')
      : undefined;
    const details = new Map<number, DecodedAffinityBlob>();
    if (Array.isArray(extensions.reasoning_details)) {
      for (const [detailIndex, detail] of extensions.reasoning_details.entries()) {
        if (!isEncryptedReasoningDetail(detail)) continue;
        details.set(detailIndex, await codec.unwrap(detail.data, 'openai-chat-completions.reasoning_details.reasoning.encrypted.data'));
      }
    }
    if (opaque !== undefined || details.size > 0) locations.push({ index, opaque, details });
  }

  return defineAffinityRequest([], candidate => {
    const messages = locations.map(({ index, opaque, details }) => {
      const opaqueProjection = opaque === undefined ? undefined : projectOptionalAffinityBlob(opaque, candidate);
      const detailProjections = new Map([...details].map(([detailIndex, blob]) => [detailIndex, projectOptionalAffinityBlob(blob, candidate)]));
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
    });
    return {
      kind: 'accepted',
      degrades: messages.some(message => message.degrades),
      preferred: messages.every(message => message.preferred),
      materialize: () => {
        if (messages.length === 0) return payload;
        const byIndex = new Map(messages.map(projection => [projection.index, projection]));
        return {
          ...payload, messages: payload.messages.map((source, index) => {
            const projected = byIndex.get(index);
            if (projected === undefined) return source;
            if (source.role !== 'assistant') throw new Error('OpenAI Chat Completions affinity expected an assistant message');
            const message: OpenAIChatCompletionsAssistantMessageEx = { ...source };
            const { opaqueProjection, detailProjections, dropsReasoning } = projected;
            if (dropsReasoning) {
              delete message.reasoning_opaque;
              for (const field of reasoningFields) delete message[field];
              return message;
            }
            if (opaqueProjection?.kind === 'preserve') message.reasoning_opaque = opaqueProjection.value;
            else if (opaqueProjection?.kind === 'remove') delete message.reasoning_opaque;
            if (detailProjections.size === 0) return message;
            if (!Array.isArray(message.reasoning_details)) throw new Error('OpenAI Chat Completions affinity expected reasoning details');
            const reasoningDetails = message.reasoning_details.flatMap((detail, detailIndex) => {
              const projection = detailProjections.get(detailIndex);
              if (projection === undefined) return [detail];
              if (projection.kind === 'remove') return [];
              if (!isEncryptedReasoningDetail(detail)) throw new Error(`Recorded encrypted reasoning detail is missing at index ${detailIndex}`);
              return [{ ...detail, data: projection.value }];
            });
            if (reasoningDetails.length === 0) delete message.reasoning_details;
            else message.reasoning_details = reasoningDetails;
            return message;
          }),
        };
      },
    };
  });
};
