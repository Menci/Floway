import { klona } from 'klona/json';

import {
  cleanOpenAIChatCompletionsAssistantTurn,
  inspectOpenAIChatCompletionsAssistantTurn,
  partitionOpenAIChatCompletionsTurns,
  prepareIRRoundTripAssistantTurn,
  verifyOpenAIChatCompletionsReplayCheck,
  type PreparedIRRoundTripAssistantTurn,
} from '../shared/ir/round-trip/index.ts';
import { openaiChatCompletionsContentToOpenAIResponsesInputContent, openaiChatCompletionsContentToText } from '../shared/openai-chat-completions-and-openai-responses/content.ts';
import { openAIChatCompletionsScalarReasoningText, scalarToOpenAIResponsesReasoningItem, translateOpenAIChatCompletionsReasoningItems } from '../shared/openai-chat-completions-and-openai-responses/reasoning.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import type { AssistantTurnSidecarCodec } from '../types.ts';
import type { OpenAIChatCompletionsAssistantMessage, OpenAIChatCompletionsAssistantMessageEx, OpenAIChatCompletionsReasoningItem, OpenAIChatCompletionsPayload, OpenAIChatCompletionsTool } from '@floway-dev/protocols/openai-chat-completions';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesInputContent, CanonicalOpenAIResponsesInputItem, OpenAIResponsesInputReasoning, OpenAIResponsesTool, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';

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

type PreparedChatAssistantTurn = PreparedIRRoundTripAssistantTurn<OpenAIChatCompletionsAssistantMessageEx, 'openaiResponses'>;
type RestoredResponsesAssistantTurn = Extract<PreparedChatAssistantTurn, { kind: 'target' }>['turn'];

const buildTargetRequestWithReplay = (
  payload: OpenAIChatCompletionsPayload,
  restoredTurns: ReadonlyMap<number, RestoredResponsesAssistantTurn>,
): CanonicalOpenAIResponsesPayload => {
  const instructions: string[] = [];
  const input: CanonicalOpenAIResponsesInputItem[] = [];
  const customToolCallIds = new Set<string>();
  let hoistSystemPrefix = true;

  for (const [messageIndex, message] of payload.messages.entries()) {
    // Only the initial OpenAI Chat Completions `system` prefix maps cleanly to OpenAI Responses
    // `instructions`; later `system` and `developer` turns are
    // chronology-bearing input items.
    if (hoistSystemPrefix && message.role === 'system') {
      const text = openaiChatCompletionsContentToText(message.content);
      if (text) instructions.push(text);
      continue;
    }

    hoistSystemPrefix = false;

    if (message.role === 'user') {
      input.push({
        type: 'message',
        role: 'user',
        content: openaiChatCompletionsContentToOpenAIResponsesInputContent(message.content),
      });
      continue;
    }

    if (message.role === 'assistant') {
      const restoredTurn = restoredTurns.get(messageIndex);
      if (restoredTurn !== undefined) {
        input.push(...restoredTurn);
        for (const item of restoredTurn) if (item.type === 'custom_tool_call') customToolCallIds.add(item.call_id);
        continue;
      }
      const assistantContent = translateAssistantContent(message);
      const extensions = message as OpenAIChatCompletionsAssistantMessageEx;
      const reasoningItems = translateOpenAIChatCompletionsReasoningItems<OpenAIResponsesInputReasoning>(extensions.reasoning_items as OpenAIChatCompletionsReasoningItem[] | null | undefined);
      const scalarReasoning = scalarToOpenAIResponsesReasoningItem<OpenAIResponsesInputReasoning>(openAIChatCompletionsScalarReasoningText(extensions));
      if (reasoningItems) {
        input.push(...reasoningItems);
      } else if (scalarReasoning) {
        input.push(scalarReasoning);
      }

      if (message.tool_calls?.length) {
        if (assistantContent.length > 0) {
          input.push({
            type: 'message',
            role: 'assistant',
            content: assistantContent,
          });
        }

        for (const toolCall of message.tool_calls) {
          if (toolCall.type === 'custom') {
            customToolCallIds.add(toolCall.id);
            input.push({ type: 'custom_tool_call', call_id: toolCall.id, ...toolCall.custom, status: 'completed' });
            continue;
          }
          input.push({
            type: 'function_call',
            call_id: toolCall.id,
            name: toolCall.function.name,
            arguments: toolCall.function.arguments,
            status: 'completed',
          });
        }

        continue;
      }

      input.push({
        type: 'message',
        role: 'assistant',
        content: assistantContent.length > 0 ? assistantContent : '',
      });
      continue;
    }

    if (message.role === 'system' || message.role === 'developer') {
      input.push({
        type: 'message',
        role: message.role,
        content: openaiChatCompletionsContentToOpenAIResponsesInputContent(message.content),
      });
      continue;
    }

    if (message.role !== 'tool') {
      throw new TranslatorInputError(`Invalid role '${(message as { role: string }).role}'.`);
    }

    if (!message.tool_call_id) {
      throw new TranslatorInputError("Missing required field 'tool_call_id' on a 'tool' role message.");
    }

    input.push({
      type: customToolCallIds.has(message.tool_call_id) ? 'custom_tool_call_output' : 'function_call_output',
      call_id: message.tool_call_id,
      output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
    });
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

export const buildTargetRequest = (payload: OpenAIChatCompletionsPayload): CanonicalOpenAIResponsesPayload => buildTargetRequestWithReplay(payload, new Map());

export const buildRoundTripTargetRequest = async (payload: OpenAIChatCompletionsPayload, codec: AssistantTurnSidecarCodec): Promise<CanonicalOpenAIResponsesPayload> => {
  const messages = [...payload.messages];
  const restoredTurns = new Map<number, RestoredResponsesAssistantTurn>();
  let messageIndex = 0;
  for (const turn of partitionOpenAIChatCompletionsTurns(payload.messages)) {
    const start = messageIndex;
    messageIndex += turn.items.length;
    if (turn.role !== 'assistant') continue;
    const assistantTurn = turn.items[0] as OpenAIChatCompletionsAssistantMessageEx;
    const prepared = await prepareIRRoundTripAssistantTurn(
      'openaiChatCompletions',
      'openaiResponses',
      assistantTurn,
      codec,
      inspectOpenAIChatCompletionsAssistantTurn,
      verifyOpenAIChatCompletionsReplayCheck,
      cleanOpenAIChatCompletionsAssistantTurn,
    );
    if (prepared.kind === 'target') restoredTurns.set(start, prepared.turn);
    else messages[start] = prepared.turn;
  }
  return buildTargetRequestWithReplay({ ...payload, messages }, restoredTurns);
};
