import { type AffinityCodec, type AffinityRequestAnalysis, type DecodedAffinityBlob, defineAffinityRequest, projectOptionalAffinityBlob } from '../../shared/affinity/index.ts';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

export const analyzeOpenAIChatCompletionsAffinity = async (
  payload: OpenAIChatCompletionsPayload,
  codec: AffinityCodec,
): Promise<AffinityRequestAnalysis<OpenAIChatCompletionsPayload>> => {
  const decoded = new Map<number, DecodedAffinityBlob>();
  for (const [index, message] of payload.messages.entries()) {
    if (message.role !== 'assistant' || typeof message.reasoning_opaque !== 'string') continue;
    decoded.set(index, await codec.unwrap(message.reasoning_opaque, 'openai-chat-completions.reasoning_opaque'));
  }

  return defineAffinityRequest([], candidate => {
    const projections = [...decoded].map(([index, blob]) => ({ index, projection: projectOptionalAffinityBlob(blob, candidate) }));
    return {
      kind: 'accepted',
      degrades: projections.some(item => item.projection.kind === 'remove' && item.projection.degrades),
      materialize: () => {
        const candidatePayload = structuredClone(payload);
        for (const { index, projection } of projections) {
          const message = candidatePayload.messages[index];
          if (projection.kind === 'preserve') message.reasoning_opaque = projection.value;
          else if (projection.kind === 'remove') delete message.reasoning_opaque;
        }
        return candidatePayload;
      },
    };
  });
};
