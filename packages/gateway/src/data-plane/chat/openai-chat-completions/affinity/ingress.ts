import { isEncryptedReasoningDetail } from './reasoning-details.ts';
import { type AffinityCodec, type AffinityRequestAnalysis, type DecodedAffinityBlob, defineAffinityRequest, projectOptionalAffinityBlob } from '../../shared/affinity/index.ts';
import { withKeysChanged } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

export const analyzeOpenAIChatCompletionsAffinity = async (
  payload: OpenAIChatCompletionsPayload,
  codec: AffinityCodec,
): Promise<AffinityRequestAnalysis<OpenAIChatCompletionsPayload>> => {
  const decodedOpaque = new Map<number, DecodedAffinityBlob>();
  const decodedDetails = new Map<number, { details: unknown[]; blobs: Map<number, DecodedAffinityBlob> }>();
  for (const [index, message] of payload.messages.entries()) {
    if (message.role !== 'assistant') continue;
    const extensions = message as OpenAIChatCompletionsAssistantMessageEx;
    if (typeof extensions.reasoning_opaque === 'string') {
      decodedOpaque.set(index, await codec.unwrap(extensions.reasoning_opaque, 'openai-chat-completions.reasoning_opaque'));
    }
    if (!Array.isArray(extensions.reasoning_details)) continue;
    const blobs = new Map<number, DecodedAffinityBlob>();
    for (const [detailIndex, detail] of extensions.reasoning_details.entries()) {
      if (!isEncryptedReasoningDetail(detail)) continue;
      blobs.set(detailIndex, await codec.unwrap(detail.data, 'openai-chat-completions.reasoning_details.reasoning.encrypted.data'));
    }
    if (blobs.size > 0) decodedDetails.set(index, { details: extensions.reasoning_details, blobs });
  }

  return defineAffinityRequest([], candidate => {
    const opaqueProjections = [...decodedOpaque].map(([index, blob]) => ({ index, projection: projectOptionalAffinityBlob(blob, candidate) }));
    const detailProjections = [...decodedDetails].map(([index, { details, blobs }]) => ({
      index,
      details,
      projections: new Map([...blobs].map(([detailIndex, blob]) => [detailIndex, projectOptionalAffinityBlob(blob, candidate)])),
    }));
    const projections = [...opaqueProjections.map(item => item.projection), ...detailProjections.flatMap(item => [...item.projections.values()])];
    return {
      kind: 'accepted',
      degrades: projections.some(projection => projection.kind === 'remove' && projection.degrades),
      preferred: projections.every(projection => projection.preferred),
      materialize: () => {
        const patches = new Map<number, Record<string, unknown>>();
        const patchOf = (index: number) => patches.get(index) ?? patches.set(index, {}).get(index)!;
        for (const { index, projection } of opaqueProjections) {
          patchOf(index).reasoning_opaque = projection.kind === 'preserve' ? projection.value : undefined;
        }
        for (const { index, details, projections } of detailProjections) {
          const reasoningDetails = details.flatMap((detail, detailIndex) => {
            const projection = projections.get(detailIndex);
            if (projection === undefined) return [detail];
            if (projection.kind === 'remove') return [];
            if (!isEncryptedReasoningDetail(detail)) throw new Error(`Recorded encrypted reasoning detail is missing at index ${detailIndex}`);
            return [{ ...detail, data: projection.value }];
          });
          patchOf(index).reasoning_details = reasoningDetails.length === 0 ? undefined : reasoningDetails;
        }
        if (patches.size === 0) return payload;
        const messages = payload.messages.map((message, index) => {
          const patch = patches.get(index);
          return patch === undefined ? message : withKeysChanged(message, patch);
        });
        return withKeysChanged(payload, { messages });
      },
    };
  });
};
