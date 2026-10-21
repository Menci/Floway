import { klona } from 'klona/json';

import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input-segments.ts';
import type { IRInputTurn } from '../../../ir/input.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { SidecarCodec, RemoteImageLoader } from '../../../types.ts';
import { applyLastMessageCacheBreakpoint, applyLastSystemCacheBreakpoint, applyLastToolCacheBreakpoint } from '../../anthropic-messages/as-target/cache-breakpoints.ts';
import { anthropicMessagesFromIR } from '../../anthropic-messages/as-target/input-from.ts';
import { anthropicMessagesReasoningFieldsFromEffort } from '../../anthropic-messages/as-target/reasoning-effort.ts';
import { resolveImageUrlToAnthropicMessagesImage } from '../../anthropic-messages/as-target/remote-images.ts';
import { anthropicMessagesToolInputSchema } from '../../anthropic-messages/as-target/tool-input-schema.ts';
import { restrictAllowedTools } from '../as-source/allowed-tools.ts';
import { partitionOpenAIResponsesTurns } from '../as-source/conversation-turns.ts';
import { openaiResponsesDropsReasoning, openaiResponsesInstructionsToIR, openaiResponsesTurnToIR } from '../as-source/input-to.ts';
import { flattenNamespaceTools, type NamespaceToolNames } from '../as-source/namespace-tools.ts';
import { rejectProgrammaticOpenAIResponsesPayload } from '../as-source/programmatic-tooling.ts';
import { collectOpenAIResponsesReplayContents, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest } from '../as-source/round-trip.ts';
import { canonicalizeOpenAIResponsesPayload } from '../canonicalize-payload.ts';
import { buildCustomToolInputSchema } from '../common/custom-tool-wrap.ts';
import {
  ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS,
  type AnthropicMessagesMessage,
  type AnthropicMessagesPayload,
  type AnthropicMessagesTextBlockParam,
  type AnthropicMessagesTool,
} from '@floway-dev/protocols/anthropic-messages';
import { isFastServiceTier } from '@floway-dev/protocols/common';
import type {
  OpenAIResponsesRequestPayloadEx,
  OpenAIResponsesTool,
  OpenAIResponsesToolChoice,
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

const anthropicServiceTierFieldsFromOpenAI = (serviceTier: string | null | undefined): Partial<AnthropicMessagesPayload> =>
  isFastServiceTier(serviceTier)
    ? { speed: 'fast' }
    : serviceTier != null
      ? { service_tier: serviceTier }
      : {};

export interface TargetRequestResult {
  target: AnthropicMessagesPayload;
  /**
   * Names of OpenAI Responses `custom` tools the request translator wrapped as
   * single-string function tools. Returned alongside the translated payload so
   * the trip's events translator can project wrapped function calls back into
   * `custom_tool_call` outputs.
   */
  customToolNames: Set<string>;
  namespaceToolNames: NamespaceToolNames;
}

const translateTools = (
  tools: OpenAIResponsesTool[] | null | undefined,
  customToolNames: Set<string>,
): AnthropicMessagesTool[] | undefined => {
  const out: AnthropicMessagesTool[] = [];

  for (const tool of tools ?? []) {
    if (tool.type === 'function') {
      out.push({
        name: tool.name,
        // OpenAI Responses spells "this tool has no description" as an explicit
        // `null`; Anthropic Messages has no such spelling, so the key is dropped.
        ...(tool.description == null ? {} : { description: tool.description }),
        // Anthropic Messages has no spelling for "no schema" either: `input_schema` is
        // required, and forwarding `undefined` makes Anthropic reject the whole
        // request with a 400. The empty object schema is Anthropic's own
        // spelling for a tool that takes no arguments.
        // https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/src/resources/messages/messages.ts#L1845-L1852
        // https://github.com/anthropics/anthropic-sdk-typescript/blob/3b45cd3b69c956ac63384fdb09ce1d8109f3fa80/examples/managed-agents-self-hosted-sandbox-worker.ts#L34-L41
        input_schema: anthropicMessagesToolInputSchema(klona(tool.parameters) ?? { type: 'object', properties: {} }),
        ...(tool.strict == null ? {} : { strict: tool.strict }),
      });
      continue;
    }
    if (tool.type === 'custom') {
      customToolNames.add(tool.name);
      out.push({
        name: tool.name,
        description: tool.description,
        input_schema: buildCustomToolInputSchema(tool.format),
      });
      continue;
    }
    throw new TranslatorInputError(`Cannot translate OpenAI Responses tool type '${tool.type}' to Anthropic Messages.`);
  }
  return out.length > 0 ? out : undefined;
};

const translateToolChoice = (
  toolChoice: OpenAIResponsesToolChoice | null | undefined,
): AnthropicMessagesPayload['tool_choice'] => {
  if (!toolChoice) return undefined;

  if (typeof toolChoice === 'string') {
    switch (toolChoice) {
    case 'auto':
      return { type: 'auto' };
    case 'none':
      return { type: 'none' };
    case 'required':
      return { type: 'any' };
    default:
      throw new TranslatorInputError(`Cannot translate OpenAI Responses tool choice '${toolChoice}' to Anthropic Messages.`);
    }
  }

  // Both function and wrapped custom tools land on the target as named tool
  // choices since they share the function-tool wire shape after translation.
  if (toolChoice.type === 'function' || toolChoice.type === 'custom') {
    return toolChoice.name ? { type: 'tool', name: toolChoice.name } : undefined;
  }
  throw new TranslatorInputError(`Cannot translate OpenAI Responses tool choice type '${toolChoice.type}' to Anthropic Messages.`);
};

export const buildTargetRequest = async (
  source: OpenAIResponsesRequestPayloadEx,
  codec: SidecarCodec,
  options: BuildTargetRequestOptions,
): Promise<TargetRequestResult> => {
  const canonical = canonicalizeOpenAIResponsesPayload(source);
  const { payload, names: namespaceToolNames, flattenInput } = flattenNamespaceTools(canonical);
  rejectProgrammaticOpenAIResponsesPayload(payload, 'Anthropic Messages');
  const customToolNames = new Set<string>();
  const allowed = restrictAllowedTools(payload.tools, payload.tool_choice);
  const tools = translateTools(allowed.tools, customToolNames);
  // Every system block comes from the IR writer, which hoists the leading run
  // and leaves later system messages inline.
  const systemBlocks: AnthropicMessagesTextBlockParam[] = [];
  const effort = payload.reasoning?.effort;
  const maxTokens = payload.max_output_tokens ?? options.fallbackMaxOutputTokens ?? ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS;
  applyLastToolCacheBreakpoint(tools);

  // Merge reasoning effort + structured-output format into a single
  // `output_config`. `effort === 'none'` still maps to `thinking: {type:
  // 'disabled'}` (Anthropic's native disable shape), but `format` should
  // still ride along when present.
  //
  // OpenAI Responses keeps json_schema details flat (`text.format = { type, schema }`);
  // a `text` format or absent config has no Anthropic Messages equivalent and drops.
  const openaiResponsesFormat = payload.text?.format;
  const formatSchema =
    openaiResponsesFormat?.type === 'json_schema' && openaiResponsesFormat.schema && typeof openaiResponsesFormat.schema === 'object' && !Array.isArray(openaiResponsesFormat.schema)
      ? (openaiResponsesFormat.schema as Record<string, unknown>)
      : undefined;
  const { thinking, effort: outputConfigEffort } = anthropicMessagesReasoningFieldsFromEffort(effort);
  const outputConfig: NonNullable<AnthropicMessagesPayload['output_config']> = {};
  if (outputConfigEffort !== undefined) outputConfig.effort = outputConfigEffort;
  if (formatSchema) outputConfig.format = { type: 'json_schema', schema: klona(formatSchema) };
  const hasOutputConfig = Object.keys(outputConfig).length > 0;

  // OpenAI's accelerated request lane maps to Anthropic's `speed: 'fast'`;
  // other service-tier values remain open strings.
  // https://docs.claude.com/en/build-with-claude/fast-mode
  // https://platform.openai.com/docs/guides/fast-mode
  const serviceTierFields = anthropicServiceTierFieldsFromOpenAI(payload.service_tier);

  // OpenAI Responses `metadata` is intentionally omitted on the Anthropic Messages path;
  // not coerced into Anthropic metadata.user_id, prompt-cache, or safety
  // semantics.
  // A sidecar-resolved turn keeps its own cache metadata, so the last-message
  // breakpoint skips it.
  // A sidecar-resolved turn keeps the cache metadata it was stored with, so
  // only bare-translated messages are candidates for the last-message breakpoint.
  const restoredMessages = new Set<AnthropicMessagesMessage>();
  const pieces: (IRInputTurn | IRInputResolvedTurn<AnthropicMessagesMessage>)[] = [];
  // `instructions` and a leading system input are separate prompt blocks, so
  // each becomes its own IR system item and the writer hoists both.
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
  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') { irMessages.push(piece.turn); continue; }
    const translated = await anthropicMessagesFromIR({ turns: piece.turns }, piece.leading, {
      separateAfterDroppedAssistant: true,
      resolveImage: async media => {
        // Messages cannot reference a foreign file ID: the bytes must be
        // fetched, so a caller that supplied only an ID is an error.
        if (media.source_kind === 'file') throw new TranslatorInputError('Cannot translate file_id-only image content to Anthropic Messages.');
        return media.source_kind === 'url'
          ? await resolveImageUrlToAnthropicMessagesImage(media.url, options.loadRemoteImage)
          : await resolveImageUrlToAnthropicMessagesImage(`data:${media.media_type ?? ''};base64,${media.data}`, options.loadRemoteImage);
      },
    });
    if (translated.system !== undefined) systemBlocks.push(...translated.system);
    irMessages.push(...translated.messages);

  }
  const target: AnthropicMessagesPayload = {
    model: payload.model,
    messages: irMessages,
    max_tokens: maxTokens,
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    ...(payload.temperature != null ? { temperature: payload.temperature } : {}),
    ...(payload.top_p != null ? { top_p: payload.top_p } : {}),
    stream: true,
    tools,
    tool_choice: translateToolChoice(allowed.choice),
    ...(thinking ? { thinking } : {}),
    ...(hasOutputConfig ? { output_config: outputConfig } : {}),
    ...serviceTierFields,
  };

  // The system blocks are complete only after the IR writer hoisted them.
  applyLastSystemCacheBreakpoint(systemBlocks);
  applyLastMessageCacheBreakpoint(target.messages.filter(message => !restoredMessages.has(message)));
  return { target, customToolNames, namespaceToolNames };
};
