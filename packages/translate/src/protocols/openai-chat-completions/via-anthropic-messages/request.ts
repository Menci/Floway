import { readIRInput } from '../../../ir/input/source.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec, RemoteImageLoader } from '../../../types.ts';
import { resolveAnthropicMessagesImage } from '../../anthropic-messages/as-target/remote-images.ts';
import { anthropicMessagesPayloadFromSegments } from '../../anthropic-messages/as-target/segmented-request.ts';
import { openaiChatCompletionsDropsReasoning, openaiChatCompletionsSource } from '../as-source/input-to.ts';
import { collectOpenAIChatCompletionsReplayContents, findOpenAIChatCompletionsSidecarCarriers, verifyOpenAIChatCompletionsTurnDigest } from '../as-source/round-trip.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

interface BuildTargetRequestOptions {
  loadRemoteImage: RemoteImageLoader;
  /**
   * Preferred cap used when the source payload omits `max_tokens`. Callers in
   * the data plane forward the model's advertised `/models` output cap so the
   * translated Anthropic Messages request reflects the upstream-known limit rather than
   * being silently capped by a target-side default later.
   */
  fallbackMaxOutputTokens: number | undefined;
}

export const buildTargetRequest = async (
  payload: OpenAIChatCompletionsPayload,
  codec: SidecarCodec,
  options: BuildTargetRequestOptions,
): Promise<AnthropicMessagesPayload> => {
  const source = openaiChatCompletionsSource(payload);
  const pieces = await readIRInput(source, async turn => {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn(
        'openaiChatCompletions', 'anthropicMessages', turn.items[0], codec,
        findOpenAIChatCompletionsSidecarCarriers, verifyOpenAIChatCompletionsTurnDigest, collectOpenAIChatCompletionsReplayContents,
      );
      if (roundTrip !== undefined) return { resolved: roundTrip.turn };
    }
    if (openaiChatCompletionsDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('openaiChatCompletions', 'anthropicMessages');
    return undefined;
  });

  return await anthropicMessagesPayloadFromSegments(
    source.request,
    pieces,
    turn => turn,
    { resolveImage: resolveAnthropicMessagesImage(options.loadRemoteImage), fallbackMaxOutputTokens: options.fallbackMaxOutputTokens },
  );
};
