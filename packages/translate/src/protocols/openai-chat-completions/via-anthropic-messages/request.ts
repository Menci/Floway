import type { IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputMedia, IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec, RemoteImageLoader } from '../../../types.ts';
import { resolveImageUrlToAnthropicMessagesImage } from '../../anthropic-messages/as-target/remote-images.ts';
import { anthropicMessagesPayloadFromSegments } from '../../anthropic-messages/as-target/segmented-request.ts';
import { openaiChatCompletionsDropsReasoning, openaiChatCompletionsSource } from '../as-source/input-to.ts';
import { collectOpenAIChatCompletionsReplayContents, findOpenAIChatCompletionsSidecarCarriers, verifyOpenAIChatCompletionsTurnDigest } from '../as-source/round-trip.ts';
import type { AnthropicMessagesMessage, AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
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

const chatImageResolver = (loadRemoteImage: RemoteImageLoader) => async (media: IRInputMedia) => {
  if (media.source_kind === 'url') return await resolveImageUrlToAnthropicMessagesImage(media.url, loadRemoteImage);
  if (media.source_kind === 'file') return { type: 'image' as const, source: { type: 'file' as const, file_id: media.file_id } };
  // A base64 image is validated through the same data-URL path the source used,
  // so unsupported media types are dropped exactly as before.
  return await resolveImageUrlToAnthropicMessagesImage(`data:${media.media_type ?? ''};base64,${media.data}`, loadRemoteImage);
};

export const buildTargetRequest = async (
  payload: OpenAIChatCompletionsPayload,
  codec: SidecarCodec,
  options: BuildTargetRequestOptions,
): Promise<AnthropicMessagesPayload> => {
  const source = openaiChatCompletionsSource(payload);
  const pieces: (IRInputTurn | IRInputResolvedTurn<AnthropicMessagesMessage>)[] = [];
  for (const turn of source.conversation) {
    const roundTrip = turn.role === 'assistant'
      ? await roundTripAssistantTurn(
          'openaiChatCompletions', 'anthropicMessages', turn.items[0], codec,
          findOpenAIChatCompletionsSidecarCarriers, verifyOpenAIChatCompletionsTurnDigest, collectOpenAIChatCompletionsReplayContents,
        )
      : undefined;
    if (roundTrip !== undefined) { pieces.push({ kind: 'resolved', turn: roundTrip.turn }); continue; }
    if (openaiChatCompletionsDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('openaiChatCompletions', 'anthropicMessages');
    pieces.push(source.turnToIR(turn));
  }

  return await anthropicMessagesPayloadFromSegments(
    source.request,
    pieces,
    turn => turn,
    { resolveImage: chatImageResolver(options.loadRemoteImage), fallbackMaxOutputTokens: options.fallbackMaxOutputTokens },
  );
};
