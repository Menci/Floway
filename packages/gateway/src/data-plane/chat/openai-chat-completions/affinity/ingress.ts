import { type AffinityCodec, type AffinityRequestAnalysis, type DecodedAffinityBlob, defineAffinityRequest, projectOptionalAffinityBlob } from '../../shared/affinity/index.ts';
import { withKeysChanged } from '@floway-dev/protocols/common';
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
      // Rebuilt rather than cloned: the payload is the record's, so it is frozen, and a message
      // no projection touches rides through by identity. What one candidate is owed differs from
      // what the next is by a handful of objects, not by a copy of the conversation.
      materialize: () => {
        const rewritten = new Map(projections.map(({ index, projection }) => [
          index,
          withKeysChanged(payload.messages[index], {
            reasoning_opaque: projection.kind === 'preserve' ? projection.value : undefined,
          }),
        ]));
        const messages = payload.messages.map((message, index) => rewritten.get(index) ?? message);
        return withKeysChanged(payload, { messages });
      },
    };
  });
};
