import { klona } from 'klona/json';

import { openaiChatCompletionsContentToOpenAIResponsesInputContent, openaiChatCompletionsContentToText } from './content.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import { segmentIRInput, type IRInputResolvedTurn } from '../../../ir/input-segments.ts';
import type { IRInputTurn } from '../../../ir/input.ts';
import { openaiResponsesFromIR } from '../../openai-responses/as-target/request-from-ir.ts';
import { openaiChatCompletionsCallKinds, openaiChatCompletionsDropsReasoning, openaiChatCompletionsTurnToIR } from '../as-source/request-to-ir.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { SidecarCodec } from '../../../types.ts';
import { partitionOpenAIChatCompletionsTurns } from '../as-source/conversation-turns.ts';
import { collectOpenAIChatCompletionsReplayContents, hasOpenAIChatCompletionsReasoning, findOpenAIChatCompletionsSidecarCarriers, verifyOpenAIChatCompletionsTurnDigest } from '../as-source/round-trip.ts';
import type { OpenAIChatCompletionsAssistantMessage, OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayload, OpenAIChatCompletionsTool } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputContent, CanonicalOpenAIResponsesInputItem, OpenAIResponsesTool, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';

const translateChatTools = (tools?: OpenAIChatCompletionsTool[] | null): OpenAIResponsesTool[] =>
  tools?.length
    ? tools.map(tool => {
        if (tool.type === 'custom') return { type: 'custom', ...klona(tool.custom) };
        return {
          type: 'function',
          name: tool.function.name,
          parameters: klona(tool.function.parameters) ?? { type: 'object', properties: {} },
          // OpenAI Chat Completions function tools are non-strict by default while OpenAI Responses function
          // tools default strict; make omission explicit to preserve OpenAI Chat Completions semantics.
          strict: tool.function.strict ?? false,
          ...(tool.function.description ? { description: tool.function.description } : {}),
        };
      })
    : [];

const translateChatToolChoice = (choice: NonNullable<OpenAIChatCompletionsPayload['tool_choice']>): OpenAIResponsesToolChoice => {
  if (typeof choice === 'string') return choice;
  if (choice.type === 'function') return { type: 'function', name: choice.function.name };
  if (choice.type === 'custom') return { type: 'custom', name: choice.custom.name };
  return {
    type: 'allowed_tools', mode: choice.allowed_tools.mode, tools: choice.allowed_tools.tools.map(tool => {
      return tool.type === 'function' ? { type: 'function', name: tool.function.name } : { type: 'custom', name: tool.custom.name };
    }),
  };
};

const translateAssistantContent = (message: OpenAIChatCompletionsAssistantMessage): OpenAIResponsesInputContent[] => {
  const content: OpenAIResponsesInputContent[] = [];
  let hasRefusalPart = false;

  if (typeof message.content === 'string') {
    if (message.content) content.push({ type: 'output_text', text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'text') content.push({ type: 'output_text', text: part.text });
      else if (part.type === 'refusal') {
        content.push({ type: 'refusal', refusal: part.refusal });
        hasRefusalPart = true;
      }
    }
  }

  if (message.refusal !== undefined && message.refusal !== null && !hasRefusalPart) {
    content.push({ type: 'refusal', refusal: message.refusal });
  }

  return content;
};

export const buildTargetRequest = async (
  payload: OpenAIChatCompletionsPayload,
  codec: SidecarCodec,
): Promise<CanonicalOpenAIResponsesPayload> => {
  const customToolCallIds = new Set<string>();
  const callKinds = openaiChatCompletionsCallKinds(payload);

  const input: CanonicalOpenAIResponsesInputItem[] = [];
  const instructions: string[] = [];

  // A resolved assistant turn is already native Responses structure, so it
  // splits the conversation into IR segments around itself.
  const pieces: (IRInputTurn | IRInputResolvedTurn<readonly CanonicalOpenAIResponsesInputItem[]>)[] = [];
  for (const turn of partitionOpenAIChatCompletionsTurns(payload.messages)) {
    const roundTrip = turn.role === 'assistant' && await roundTripAssistantTurn(
      'openaiChatCompletions', 'openaiResponses', turn.items[0], codec,
      findOpenAIChatCompletionsSidecarCarriers, verifyOpenAIChatCompletionsTurnDigest, collectOpenAIChatCompletionsReplayContents,
    );
    if (roundTrip === undefined || roundTrip === false) {
      if (openaiChatCompletionsDropsReasoning(turn)) warnDroppedUnrecognizedAssistantReasoning('openaiChatCompletions', 'openaiResponses');
      pieces.push(openaiChatCompletionsTurnToIR(turn, callKinds));
      continue;
    }
    pieces.push({ kind: 'resolved', turn: roundTrip.turn });
  }

  for (const piece of segmentIRInput(pieces)) {
    if (piece.kind === 'resolved') {
      input.push(...piece.turn);
      for (const item of piece.turn) if (item.type === 'custom_tool_call') customToolCallIds.add(item.call_id);
      continue;
    }
    const translated = openaiResponsesFromIR({ turns: piece.turns }, piece.leading);
    if (translated.instructions !== undefined) instructions.push(translated.instructions);
    input.push(...translated.input);
  }

  const format = klona(payload.response_format);
  if (format?.type === 'json_schema' && format.json_schema.schema === undefined) throw new TranslatorInputError('Cannot translate json_schema response format without a schema.');
  const responseTextConfig = format == null ? undefined : {
    format: format.type === 'json_schema'
      ? { type: 'json_schema' as const, ...format.json_schema, schema: format.json_schema.schema! }
      : format,
  };

  const reasoningEffort = payload.reasoning_effort ?? undefined;
  const reasoning = reasoningEffort !== undefined ? { effort: reasoningEffort } : undefined;

  return {
    model: payload.model,
    input,
    ...(instructions.length > 0 ? { instructions: instructions.join('\n\n') } : {}),
    ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    ...(payload.max_tokens !== undefined ? { max_output_tokens: payload.max_tokens } : {}),
    ...(payload.tools !== undefined ? { tools: translateChatTools(payload.tools) } : {}),
    // Omit tool_choice without tools: xAI-backed upstreams reject this shape.
    // https://github.com/Wei-Shaw/sub2api/issues/4819
    // https://github.com/jlcodes99/cockpit-tools/issues/1727
    ...(payload.tool_choice != null && payload.tools?.length ? { tool_choice: translateChatToolChoice(payload.tool_choice) } : {}),
    // Same-purpose OpenAI fields are normal OpenAI Chat Completions/OpenAI Responses adapter surface;
    // provider-specific policy filtering belongs at the target boundary, not in
    // pairwise translation.
    ...(payload.metadata !== undefined ? { metadata: klona(payload.metadata) } : {}),
    stream: true,
    // Omitted store inherits the target/account default; explicit false disables it.
    // https://developers.openai.com/api/docs/guides/migrate-to-responses
    ...(payload.store !== undefined ? { store: payload.store } : {}),
    ...(payload.parallel_tool_calls !== undefined ? { parallel_tool_calls: payload.parallel_tool_calls } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(responseTextConfig !== undefined ? { text: responseTextConfig } : {}),
    ...(payload.prompt_cache_key !== undefined ? { prompt_cache_key: payload.prompt_cache_key } : {}),
    ...(payload.safety_identifier !== undefined ? { safety_identifier: payload.safety_identifier } : {}),
    ...(payload.service_tier !== undefined ? { service_tier: payload.service_tier } : {}),
  };
};
