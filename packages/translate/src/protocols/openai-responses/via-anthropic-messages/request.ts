import { irInputCustomToolNames } from '../../../ir/input/select-tools.ts';
import { readIRInput } from '../../../ir/input/source.ts';
import type { IRInputMedia } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { SidecarCodec, RemoteImageLoader } from '../../../types.ts';
import { resolveImageUrlToAnthropicMessagesImage } from '../../anthropic-messages/as-target/remote-images.ts';
import { anthropicMessagesPayloadFromSegments } from '../../anthropic-messages/as-target/segmented-request.ts';
import { openaiResponsesDropsReasoning, openaiResponsesSource } from '../as-source/input-to.ts';
import type { NamespaceToolNames } from '../as-source/namespace-tools.ts';
import { collectOpenAIResponsesReplayContents, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest } from '../as-source/round-trip.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import type { OpenAIResponsesRequestPayloadEx } from '@floway-dev/protocols/openai-responses';

interface BuildTargetRequestOptions {
  loadRemoteImage: RemoteImageLoader;
  /**
   * Preferred cap used when the source payload omits `max_output_tokens`.
   * Callers in the data plane forward the model's advertised `/models` output
   * cap so the translated Anthropic Messages request reflects the upstream-known limit
   * rather than being silently capped by a target-side default later.
   */
  fallbackMaxOutputTokens: number | undefined;
}

export interface TargetRequestResult {
  target: AnthropicMessagesPayload;
  /**
   * Names of OpenAI Responses `custom` tools the request translator wrapped as
   * single-string function tools. Returned alongside the translated payload so
   * the trip's events translator can project wrapped function calls back into
   * `custom_tool_call` outputs.
   */
  readonly customToolNames: ReadonlySet<string>;
  namespaceToolNames: NamespaceToolNames;
}

const responsesImageResolver = (loadRemoteImage: RemoteImageLoader) => async (media: IRInputMedia) => {
  // Messages cannot reference a foreign file ID: the bytes must be fetched, so a
  // caller that supplied only an ID is an error.
  if (media.source_kind === 'file') throw new TranslatorInputError('Cannot translate file_id-only image content to Anthropic Messages.');
  return media.source_kind === 'url'
    ? await resolveImageUrlToAnthropicMessagesImage(media.url, loadRemoteImage)
    : await resolveImageUrlToAnthropicMessagesImage(`data:${media.media_type ?? ''};base64,${media.data}`, loadRemoteImage);
};

export const buildTargetRequest = async (
  input: OpenAIResponsesRequestPayloadEx,
  codec: SidecarCodec,
  options: BuildTargetRequestOptions,
): Promise<TargetRequestResult> => {
  const source = openaiResponsesSource(input);
  const pieces = await readIRInput(source, async turn => {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('openaiResponses', 'anthropicMessages', turn.items, codec, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest, collectOpenAIResponsesReplayContents);
      if (roundTrip !== undefined) return { resolved: roundTrip.turn };
    }
    if (openaiResponsesDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('openaiResponses', 'anthropicMessages');
    return undefined;
  });

  const target = await anthropicMessagesPayloadFromSegments(
    source.request,
    pieces,
    turn => turn,
    // Messages carries files as `document` blocks, so a Responses `input_file`
    // is representable without loss.
    { resolveImage: responsesImageResolver(options.loadRemoteImage), fallbackMaxOutputTokens: options.fallbackMaxOutputTokens },
  );
  return { target, customToolNames: irInputCustomToolNames(source.request), namespaceToolNames: source.namespaceToolNames };
};
