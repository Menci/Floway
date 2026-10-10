import { type AffinityCodec, type AffinityRequestAnalysis, type DecodedAffinityBlob, defineAffinityRequest, projectOptionalAffinityBlob } from '../../shared/affinity/index.ts';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

const REASONING_OPAQUE_DOMAIN = 'openai-chat-completions.reasoning_opaque';
const ENCRYPTED_REASONING_DETAILS_DOMAIN = 'openai-chat-completions.reasoning_details.reasoning.encrypted.data';

type OpenAIChatCompletionsBlobLocation =
  | { readonly messageIndex: number; readonly kind: 'reasoning_opaque'; readonly decoded: DecodedAffinityBlob }
  | { readonly messageIndex: number; readonly kind: 'reasoning_details'; readonly detailIndex: number; readonly decoded: DecodedAffinityBlob };

interface OpenAIChatCompletionsBlobProjection {
  readonly location: OpenAIChatCompletionsBlobLocation;
  readonly projection: ReturnType<typeof projectOptionalAffinityBlob>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const analyzeOpenAIChatCompletionsAffinity = async (
  payload: OpenAIChatCompletionsPayload,
  codec: AffinityCodec,
): Promise<AffinityRequestAnalysis<OpenAIChatCompletionsPayload>> => {
  const locations: OpenAIChatCompletionsBlobLocation[] = [];
  for (const [index, message] of payload.messages.entries()) {
    if (message.role !== 'assistant') continue;
    const extensions = message as OpenAIChatCompletionsAssistantMessageEx;
    if (typeof extensions.reasoning_opaque === 'string' && extensions.reasoning_opaque.length > 0) {
      locations.push({
        messageIndex: index,
        kind: 'reasoning_opaque',
        decoded: await codec.unwrap(extensions.reasoning_opaque, REASONING_OPAQUE_DOMAIN),
      });
    }
    if (!Array.isArray(extensions.reasoning_details)) continue;
    for (const [detailIndex, detail] of extensions.reasoning_details.entries()) {
      if (!isRecord(detail) || detail.type !== 'reasoning.encrypted' || typeof detail.data !== 'string' || detail.data.length === 0) continue;
      locations.push({
        messageIndex: index,
        kind: 'reasoning_details',
        detailIndex,
        decoded: await codec.unwrap(detail.data, ENCRYPTED_REASONING_DETAILS_DOMAIN),
      });
    }
  }

  return defineAffinityRequest([], candidate => {
    const projections: OpenAIChatCompletionsBlobProjection[] = locations.map(location => ({
      location,
      projection: projectOptionalAffinityBlob(location.decoded, candidate),
    }));
    return {
      kind: 'accepted',
      degrades: projections.some(item => item.projection.kind === 'remove' && item.projection.degrades),
      preferred: projections.every(item => item.projection.preferred),
      materialize: () => {
        const candidatePayload = structuredClone(payload);
        const projectionsByMessage = Map.groupBy(projections, item => item.location.messageIndex);
        for (const [messageIndex, messageProjections] of projectionsByMessage) {
          const message = candidatePayload.messages[messageIndex] as OpenAIChatCompletionsAssistantMessageEx;
          for (const { location, projection } of messageProjections) {
            if (location.kind !== 'reasoning_opaque') continue;
            if (projection.kind === 'preserve') message.reasoning_opaque = projection.value;
            else delete message.reasoning_opaque;
          }

          const detailProjections = messageProjections.filter((item): item is OpenAIChatCompletionsBlobProjection & {
            readonly location: Extract<OpenAIChatCompletionsBlobLocation, { kind: 'reasoning_details' }>;
          } => item.location.kind === 'reasoning_details');
          if (detailProjections.length === 0) continue;
          const byDetail = new Map(detailProjections.map(item => [item.location.detailIndex, item]));
          const details = message.reasoning_details as Record<string, unknown>[];
          const projectedDetails = details.flatMap((detail, detailIndex) => {
            const item = byDetail.get(detailIndex);
            if (item === undefined) return [detail];
            if (item.projection.kind === 'remove') return [];
            return [{ ...detail, data: item.projection.value }];
          });
          if (projectedDetails.length === 0) delete message.reasoning_details;
          else message.reasoning_details = projectedDetails;
        }
        return candidatePayload;
      },
    };
  });
};
