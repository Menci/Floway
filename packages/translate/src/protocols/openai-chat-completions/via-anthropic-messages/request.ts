import { klona } from 'klona/json';

import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input-segments.ts';
import type { IRInputTurn } from '../../../ir/input.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { SidecarCodec, RemoteImageLoader } from '../../../types.ts';
import { applyLastMessageCacheBreakpoint, applyLastSystemCacheBreakpoint, applyLastToolCacheBreakpoint } from '../../anthropic-messages/as-target/cache-breakpoints.ts';
import { anthropicMessagesReasoningFieldsFromEffort } from '../../anthropic-messages/as-target/reasoning-effort.ts';
import { resolveImageUrlToAnthropicMessagesImage } from '../../anthropic-messages/as-target/remote-images.ts';
import { anthropicMessagesFromIR } from '../../anthropic-messages/as-target/request-from-ir.ts';
import { anthropicMessagesToolInputSchema } from '../../anthropic-messages/as-target/tool-input-schema.ts';
import { partitionOpenAIChatCompletionsTurns } from '../as-source/conversation-turns.ts';
import { openaiChatCompletionsCallKinds, openaiChatCompletionsDropsReasoning, openaiChatCompletionsTurnToIR } from '../as-source/request-to-ir.ts';
import { collectOpenAIChatCompletionsReplayContents, findOpenAIChatCompletionsSidecarCarriers, verifyOpenAIChatCompletionsTurnDigest } from '../as-source/round-trip.ts';
import { ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS, type AnthropicMessagesMessage, type AnthropicMessagesPayload, type AnthropicMessagesTextBlockParam } from '@floway-dev/protocols/anthropic-messages';
import { isFastServiceTier } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsTool } from '@floway-dev/protocols/openai-chat-completions';

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

const anthropicServiceTierFieldsFromOpenAI = (serviceTier: string | null | undefined): Partial<AnthropicMessagesPayload> =>
  isFastServiceTier(serviceTier)
    ? { speed: 'fast' }
    : serviceTier != null
      ? { service_tier: serviceTier }
      : {};

const translateOpenAIChatCompletionsTools = (tools: OpenAIChatCompletionsTool[]): AnthropicMessagesPayload['tools'] =>
  tools.map(tool => {
    if (tool.type !== 'function') throw new TranslatorInputError('Cannot translate custom Chat tools to Anthropic Messages.');
    return {
      name: tool.function.name,
      description: tool.function.description,
      input_schema: anthropicMessagesToolInputSchema(klona(tool.function.parameters) ?? { type: 'object', properties: {} }),
      ...(tool.function.strict != null ? { strict: tool.function.strict } : {}),
    };
  });

const translateOpenAIChatCompletionsToolChoice = (toolChoice: NonNullable<OpenAIChatCompletionsPayload['tool_choice']>): AnthropicMessagesPayload['tool_choice'] => {
  if (typeof toolChoice === 'string') return klona(CHAT_TOOL_CHOICES[toolChoice]);

  if (toolChoice.type === 'allowed_tools') return { type: toolChoice.allowed_tools.mode === 'required' ? 'any' : 'auto' };
  if (toolChoice.type !== 'function') throw new TranslatorInputError(`Cannot translate ${toolChoice.type} Chat tool choice to Anthropic Messages.`);
  return { type: 'tool', name: toolChoice.function.name };
};

const CHAT_TOOL_CHOICES = {
  auto: { type: 'auto' },
  none: { type: 'none' },
  required: { type: 'any' },
} satisfies Record<Extract<OpenAIChatCompletionsPayload['tool_choice'], string>, AnthropicMessagesPayload['tool_choice']>;

export const buildTargetRequest = async (
  payload: OpenAIChatCompletionsPayload,
  codec: SidecarCodec,
  options: BuildTargetRequestOptions,
): Promise<AnthropicMessagesPayload> => {
  const callKinds = openaiChatCompletionsCallKinds(payload);
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
    pieces.push(openaiChatCompletionsTurnToIR(turn, callKinds));
  }

  const systemBlocks: AnthropicMessagesTextBlockParam[] = [];
  const messages: AnthropicMessagesMessage[] = [];
  const restoredMessages = new Set<AnthropicMessagesMessage>();
  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') {
      messages.push(piece.turn);
      restoredMessages.add(piece.turn);
      continue;
    }
    const translated = await anthropicMessagesFromIR({ turns: piece.turns }, piece.leading, {
      resolveImage: async media => {
        if (media.source_kind === 'url') return await resolveImageUrlToAnthropicMessagesImage(media.url, options.loadRemoteImage);
        if (media.source_kind === 'file') return { type: 'image', source: { type: 'file', file_id: media.file_id } };
        // A base64 image is validated through the same data-URL path the source
        // used, so unsupported media types are dropped exactly as before.
        const url = `data:${media.media_type ?? ''};base64,${media.data}`;
        return await resolveImageUrlToAnthropicMessagesImage(url, options.loadRemoteImage);
      },
    });
    if (translated.system !== undefined) systemBlocks.push(...translated.system);
    // Messages requires a non-empty content array; an image that could not be
    // resolved leaves an empty text block, matching the previous behaviour.
    messages.push(...translated.messages.map(message => message.role === 'user' && Array.isArray(message.content) && message.content.length === 0
      ? { ...message, content: [{ type: 'text' as const, text: '' }] }
      : message));
  }

  const maxTokens = payload.max_tokens ?? options.fallbackMaxOutputTokens ?? ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS;
  const allowedTools = typeof payload.tool_choice === 'object' && payload.tool_choice?.type === 'allowed_tools'
    ? new Set(payload.tool_choice.allowed_tools.tools.map(tool => {
        if (tool.type !== 'function') throw new TranslatorInputError('Cannot translate custom Chat tools to Anthropic Messages.');
        return tool.function.name;
      }))
    : undefined;
  const selectedTools = allowedTools === undefined ? payload.tools : payload.tools?.filter(tool => tool.type === 'function' && allowedTools.has(tool.function.name));
  const tools = selectedTools?.length ? translateOpenAIChatCompletionsTools(selectedTools) : undefined;
  applyLastSystemCacheBreakpoint(systemBlocks);
  applyLastToolCacheBreakpoint(tools);
  applyLastMessageCacheBreakpoint(messages.filter(message => !restoredMessages.has(message)));

  // Merge OpenAI Chat Completions `reasoning_effort` + `response_format` into a single Anthropic Messages
  // `output_config` so a chat-source structured-output request survives
  // routing through an Anthropic Messages target. `reasoning_effort: 'none'` lands on
  // `thinking` instead of `output_config`, and `format` still rides along.
  //
  // OpenAI Chat Completions nests json_schema details (`response_format = { type: 'json_schema',
  // json_schema: { schema } }`); `json_object` / `text` / absent have no
  // Anthropic Messages equivalent and drop.
  const { thinking, effort: reasoningEffort } = anthropicMessagesReasoningFieldsFromEffort(payload.reasoning_effort);
  const responseFormat = payload.response_format;
  const jsonSchema = responseFormat?.type === 'json_schema' ? (responseFormat.json_schema as Record<string, unknown> | undefined) : undefined;
  const formatSchema =
    jsonSchema?.schema && typeof jsonSchema.schema === 'object' && !Array.isArray(jsonSchema.schema) ? (jsonSchema.schema as Record<string, unknown>) : undefined;
  const outputConfig: NonNullable<AnthropicMessagesPayload['output_config']> = {};
  if (reasoningEffort !== undefined) outputConfig.effort = reasoningEffort;
  if (formatSchema) outputConfig.format = { type: 'json_schema', schema: klona(formatSchema) };
  const hasOutputConfig = Object.keys(outputConfig).length > 0;

  // OpenAI's accelerated request lane maps to Anthropic's `speed: 'fast'`;
  // other service-tier values remain open strings.
  // https://docs.claude.com/en/build-with-claude/fast-mode
  // https://platform.openai.com/docs/guides/fast-mode
  const serviceTierFields = anthropicServiceTierFieldsFromOpenAI(payload.service_tier);

  // OpenAI user and generic metadata are not interpreted as Messages user_id.
  return {
    model: payload.model,
    messages,
    max_tokens: maxTokens,
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    ...(payload.temperature != null ? { temperature: payload.temperature } : {}),
    ...(payload.top_p != null ? { top_p: payload.top_p } : {}),
    ...(payload.stop != null
      ? {
          stop_sequences: Array.isArray(payload.stop) ? klona(payload.stop) : [payload.stop],
        }
      : {}),
    stream: true,
    ...(tools ? { tools } : {}),
    ...(payload.tool_choice != null ? { tool_choice: translateOpenAIChatCompletionsToolChoice(payload.tool_choice) } : {}),
    ...(thinking ? { thinking } : {}),
    ...(hasOutputConfig ? { output_config: outputConfig } : {}),
    ...serviceTierFields,
  };
};
