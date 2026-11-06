import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input/segments.ts';
import { irInputCustomToolNames } from '../../../ir/input/select-tools.ts';
import type { IRInputMedia, IRInputRequest, IRInputTurn } from '../../../ir/input/types.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { SidecarCodec, RemoteImageLoader } from '../../../types.ts';
import { applyLastMessageCacheBreakpoint, applyLastSystemCacheBreakpoint, applyLastToolCacheBreakpoint } from '../../anthropic-messages/as-target/cache-breakpoints.ts';
import { anthropicMessagesRequestFromIR } from '../../anthropic-messages/as-target/input-from.ts';
import { resolveImageUrlToAnthropicMessagesImage } from '../../anthropic-messages/as-target/remote-images.ts';
import { validateAllowedTools } from '../as-source/allowed-tools.ts';
import { partitionOpenAIResponsesTurns } from '../as-source/conversation-turns.ts';
import { openaiResponsesSettingsToIR, openaiResponsesToolsToIR, openaiResponsesDropsReasoning, openaiResponsesInstructionsToIR, openaiResponsesTurnToIR } from '../as-source/input-to.ts';
import { flattenNamespaceTools, type NamespaceToolNames } from '../as-source/namespace-tools.ts';
import { rejectProgrammaticOpenAIResponsesPayload } from '../as-source/programmatic-tooling.ts';
import { collectOpenAIResponsesReplayContents, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest } from '../as-source/round-trip.ts';
import { canonicalizeOpenAIResponsesPayload } from '../canonicalize-payload.ts';
import {
  type AnthropicMessagesMessage,
  type AnthropicMessagesPayload,
  type AnthropicMessagesTextBlockParam,
} from '@floway-dev/protocols/anthropic-messages';
import type {
  OpenAIResponsesRequestPayloadEx,
} from '@floway-dev/protocols/openai-responses';

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
  source: OpenAIResponsesRequestPayloadEx,
  codec: SidecarCodec,
  options: BuildTargetRequestOptions,
): Promise<TargetRequestResult> => {
  const canonical = canonicalizeOpenAIResponsesPayload(source);
  const { payload, names: namespaceToolNames, flattenInput } = flattenNamespaceTools(canonical);
  // A subset selector names flat callables, so it is checked once namespace and
  // hosted selectors have been rewritten into them: one that still is not flat
  // names something this translation cannot carry.
  validateAllowedTools(payload.tools, payload.tool_choice, payload.input);
  rejectProgrammaticOpenAIResponsesPayload(payload, 'Anthropic Messages');
  const systemBlocks: AnthropicMessagesTextBlockParam[] = [];

  const restoredMessages = new Set<AnthropicMessagesMessage>();
  const pieces: (IRInputTurn | IRInputResolvedTurn<AnthropicMessagesMessage>)[] = [];
  // `instructions` and a leading system input are separate prompt blocks, so
  // each becomes its own output IR system item and the writer hoists both.
  const instructions = openaiResponsesInstructionsToIR(payload.instructions);
  if (instructions !== undefined) pieces.push(instructions);
  for (const turn of partitionOpenAIResponsesTurns(canonical.input)) {
    if (turn.role === 'assistant') {
      const roundTrip = await roundTripAssistantTurn('openaiResponses', 'anthropicMessages', turn.items, codec, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest, collectOpenAIResponsesReplayContents);
      if (roundTrip !== undefined) {
        pieces.push({ kind: 'resolved', turn: roundTrip.turn });
        restoredMessages.add(roundTrip.turn);
        continue;
      }
      if (openaiResponsesDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('openaiResponses', 'anthropicMessages');
    }
    pieces.push(...openaiResponsesTurnToIR(turn, flattenInput));
  }

  const irMessages: AnthropicMessagesMessage[] = [];
  const request: IRInputRequest = {
    conversation: { turns: [] },
    settings: openaiResponsesSettingsToIR(payload),
    ...openaiResponsesToolsToIR(payload),
  };
  let base: AnthropicMessagesPayload | undefined;
  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') { irMessages.push(piece.turn); continue; }
    const translated = await anthropicMessagesRequestFromIR(
      { ...request, conversation: { turns: piece.turns } },
      {
        // Messages carries files as `document` blocks, so a Responses
        // `input_file` is representable without loss.
        resolveImage: responsesImageResolver(options.loadRemoteImage),
        fallbackMaxOutputTokens: options.fallbackMaxOutputTokens,
      },
    );
    base ??= translated;
    if (translated.system !== undefined) systemBlocks.push(...(typeof translated.system === 'string' ? [{ type: 'text' as const, text: translated.system }] : translated.system));
    irMessages.push(...translated.messages);
  }
  base ??= await anthropicMessagesRequestFromIR({ ...request, conversation: { turns: [] } }, {
    resolveImage: responsesImageResolver(options.loadRemoteImage),
    fallbackMaxOutputTokens: options.fallbackMaxOutputTokens,
  });

  const target: AnthropicMessagesPayload = {
    ...base,
    messages: irMessages,
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
  };

  // The system blocks are complete only after the writer hoisted them.
  //
  applyLastSystemCacheBreakpoint(systemBlocks);
  applyLastToolCacheBreakpoint(target.tools);
  applyLastMessageCacheBreakpoint(target.messages.filter(message => !restoredMessages.has(message)));
  return { target, customToolNames: irInputCustomToolNames(request), namespaceToolNames };
};
