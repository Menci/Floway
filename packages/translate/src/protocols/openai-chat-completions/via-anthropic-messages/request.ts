import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import type { IRInputMedia, IRInputRequest, IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import type { SidecarCodec, RemoteImageLoader } from '../../../types.ts';
import { applyLastMessageCacheBreakpoint, applyLastSystemCacheBreakpoint, applyLastToolCacheBreakpoint } from '../../anthropic-messages/as-target/cache-breakpoints.ts';
import { anthropicMessagesRequestFromIR } from '../../anthropic-messages/as-target/input-from.ts';
import { resolveImageUrlToAnthropicMessagesImage } from '../../anthropic-messages/as-target/remote-images.ts';
import { partitionOpenAIChatCompletionsTurns } from '../as-source/conversation-turns.ts';
import { openaiChatCompletionsSettingsToIR, openaiChatCompletionsInputContext, openaiChatCompletionsToolsToIR, openaiChatCompletionsDropsReasoning, openaiChatCompletionsTurnToIR } from '../as-source/input-to.ts';
import { collectOpenAIChatCompletionsReplayContents, findOpenAIChatCompletionsSidecarCarriers, verifyOpenAIChatCompletionsTurnDigest } from '../as-source/round-trip.ts';
import { type AnthropicMessagesMessage, type AnthropicMessagesPayload, type AnthropicMessagesTextBlockParam } from '@floway-dev/protocols/anthropic-messages';
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
  const context = openaiChatCompletionsInputContext(payload);
  const request: IRInputRequest = {
    conversation: { turns: [] },
    settings: openaiChatCompletionsSettingsToIR(payload),
    ...openaiChatCompletionsToolsToIR(payload),
  };
  const pieces: (IRInputTurn | IRInputResolvedTurn<AnthropicMessagesMessage>)[] = [];
  for (const turn of partitionOpenAIChatCompletionsTurns(payload.messages)) {
    const roundTrip = turn.role === 'assistant'
      ? await roundTripAssistantTurn(
          'openaiChatCompletions', 'anthropicMessages', turn.items[0], codec,
          findOpenAIChatCompletionsSidecarCarriers, verifyOpenAIChatCompletionsTurnDigest, collectOpenAIChatCompletionsReplayContents,
        )
      : undefined;
    if (roundTrip !== undefined) { pieces.push({ kind: 'resolved', turn: roundTrip.turn }); continue; }
    if (openaiChatCompletionsDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('openaiChatCompletions', 'anthropicMessages');
    pieces.push(openaiChatCompletionsTurnToIR(turn, context));
  }

  const systemBlocks: AnthropicMessagesTextBlockParam[] = [];
  const messages: AnthropicMessagesMessage[] = [];
  const restoredMessages = new Set<AnthropicMessagesMessage>();
  let base: AnthropicMessagesPayload | undefined;
  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') {
      messages.push(piece.turn);
      restoredMessages.add(piece.turn);
      continue;
    }
    const translated = await anthropicMessagesRequestFromIR(
      { ...request, conversation: { turns: piece.turns } },
      { resolveImage: chatImageResolver(options.loadRemoteImage), fallbackMaxOutputTokens: options.fallbackMaxOutputTokens },
    );
    // Every segment states the same request-wide fields; the first one supplies
    // them and each segment contributes only its conversation.
    base ??= translated;
    if (translated.system !== undefined) systemBlocks.push(...(translated.system as AnthropicMessagesTextBlockParam[]));
    // Messages requires a non-empty content array; an image that could not be
    // resolved leaves an empty text block, matching the previous behaviour.
    messages.push(...translated.messages.map(message => message.role === 'user' && Array.isArray(message.content) && message.content.length === 0
      ? { ...message, content: [{ type: 'text' as const, text: '' }] }
      : message));
  }

  // The conversation came from the segments; a request with no IR segment at all
  // still states its settings and tools.
  base ??= await anthropicMessagesRequestFromIR({ ...request, conversation: { turns: [] } }, {
    resolveImage: chatImageResolver(options.loadRemoteImage),
    fallbackMaxOutputTokens: options.fallbackMaxOutputTokens,
  });

  applyLastSystemCacheBreakpoint(systemBlocks);
  applyLastToolCacheBreakpoint(base.tools);
  applyLastMessageCacheBreakpoint(messages.filter(message => !restoredMessages.has(message)));

  return {
    ...base,
    messages,
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
  };
};
