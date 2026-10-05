import { chatAffinityCarriers, OPENAI_CHAT_COMPLETIONS_AFFINITY_DOMAIN, replaceChatAffinityCarriers, type ChatAffinityCarrier } from './carriers.ts';
import { type AffinityCodec, type AffinityRequestAnalysis, type DecodedAffinityBlob, defineAffinityRequest, projectOptionalAffinityBlob } from '../../shared/affinity/index.ts';
import type { OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

export const analyzeOpenAIChatCompletionsAffinity = async (
  payload: OpenAIChatCompletionsPayload,
  codec: AffinityCodec,
): Promise<AffinityRequestAnalysis<OpenAIChatCompletionsPayload>> => {
  const decoded: Array<{ index: number; carrier: ChatAffinityCarrier; blob: DecodedAffinityBlob }> = [];
  for (const [index, message] of payload.messages.entries()) {
    if (message.role !== 'assistant') continue;
    for (const carrier of chatAffinityCarriers(message as OpenAIChatCompletionsAssistantMessageEx)) decoded.push({ index, carrier, blob: await codec.unwrap(carrier.value, OPENAI_CHAT_COMPLETIONS_AFFINITY_DOMAIN) });
  }
  return defineAffinityRequest([], candidate => {
    const projections = decoded.map(item => ({ ...item, projection: projectOptionalAffinityBlob(item.blob, candidate) }));
    return {
      kind: 'accepted',
      degrades: projections.some(item => item.projection.kind === 'remove' && item.projection.degrades),
      preferred: projections.every(item => item.projection.preferred),
      materialize: () => {
        if (projections.length === 0) return payload;
        const messages = [...payload.messages];
        for (const index of new Set(projections.map(item => item.index))) {
          const replacements = projections.filter(item => item.index === index).map(item => ({ carrier: item.carrier, ...(item.projection.kind === 'preserve' ? { value: item.projection.value } : {}) }));
          messages[index] = replaceChatAffinityCarriers(messages[index] as OpenAIChatCompletionsAssistantMessageEx, replacements);
        }
        return { ...payload, messages };
      },
    };
  });
};
