import { responsesContentToChatContent, responsesContentToText } from '../shared/chat-and-responses/content.ts';
import { addResponseReasoningToChatProjection, type ChatReasoningProjection, chatReasoningProjectionFields, createChatReasoningProjection } from '../shared/chat-and-responses/reasoning.ts';
import { buildCustomToolInputSchema } from '../shared/responses-via/custom-tool-wrap.ts';
import type { ChatCompletionsPayload, Message, Tool, ToolCall } from '@floway-dev/protocols/chat-completions';
import type { ResponsesPayload, ResponseTool, ResponseToolChoice } from '@floway-dev/protocols/responses';

interface AssistantAccumulator {
  message: Message;
  reasoning: ChatReasoningProjection;
}

const ensureAssistant = (assistant: AssistantAccumulator | null): AssistantAccumulator =>
  assistant ?? {
    message: { role: 'assistant', content: null },
    reasoning: createChatReasoningProjection(),
  };

const appendAssistantText = (assistant: AssistantAccumulator | null, text: string): AssistantAccumulator | null => {
  if (!text) return assistant;

  const next = ensureAssistant(assistant);
  next.message.content = typeof next.message.content === 'string' ? next.message.content + text : text;
  return next;
};

const appendAssistantToolCall = (
  assistant: AssistantAccumulator | null,
  call: { call_id: string; name: string; arguments: string },
): AssistantAccumulator => {
  const next = ensureAssistant(assistant);
  next.message.tool_calls = [
    ...(next.message.tool_calls ?? []),
    {
      id: call.call_id,
      type: 'function',
      function: {
        name: call.name,
        arguments: call.arguments,
      },
    } satisfies ToolCall,
  ];
  return next;
};

const translateResponseTools = (tools: ResponseTool[] | null | undefined, customToolNames: Set<string>): Tool[] | undefined => {
  if (!tools || tools.length === 0) return undefined;

  // Translated Chat Completions targets do not currently have a faithful bridge
  // for hosted/deferred Responses tools (`web_search`, `tool_search`,
  // `namespace`, `image_generation`, and future builtin names). Native
  // Responses targets receive those entries unchanged; this translator narrows
  // to function and Freeform `custom` tools until the translated semantics are
  // defined.
  const out: Tool[] = [];
  for (const tool of tools) {
    if (tool.type === 'function') {
      out.push({
        type: 'function',
        function: {
          name: tool.name,
          parameters: tool.parameters,
          strict: tool.strict,
          ...(tool.description ? { description: tool.description } : {}),
        },
      });
      continue;
    }
    if (tool.type === 'custom') {
      customToolNames.add(tool.name);
      out.push({
        type: 'function',
        function: {
          name: tool.name,
          parameters: buildCustomToolInputSchema(tool.format),
          strict: false,
          ...(tool.description ? { description: tool.description } : {}),
        },
      });
    }
  }
  return out.length > 0 ? out : undefined;
};

const translateResponseToolChoice = (choice?: ResponseToolChoice): ChatCompletionsPayload['tool_choice'] => {
  if (choice == null) return undefined;
  if (typeof choice === 'string') return choice;
  // Both function and wrapped custom tools land on the target as named function
  // choices since they share the function-tool wire shape after translation.
  if (choice.type !== 'function' && choice.type !== 'custom') return undefined;
  return { type: 'function', function: { name: choice.name } };
};

const buildChatResponseFormat = (text: ResponsesPayload['text']): ChatCompletionsPayload['response_format'] | undefined => {
  if (text === undefined) return undefined;
  if (text === null) return null;
  // `text: {}` means no explicit format. Keep it omitted instead of converting
  // absence into an explicit Chat `response_format: null`.
  const format = text.format;
  if (!Object.hasOwn(text, 'format') || format === undefined) return undefined;
  if (format === null) return null;
  // Responses API uses a flat json_schema shape
  // ({ type, name, strict, schema }), while Chat Completions wraps the
  // schema details under a nested `json_schema` field. Reshape only when
  // needed; pass `text`/`json_object` and already-wrapped variants through.
  // Without this, upstreams reject the request with
  // "When response_format type is 'json_schema', the 'json_schema' field
  // must be provided", which Codex's review/guardian flow trips on.
  // References:
  //   https://platform.openai.com/docs/api-reference/responses/create
  //   https://platform.openai.com/docs/api-reference/chat/create#chat-create-response_format
  if (format.type === 'json_schema' && !('json_schema' in format)) {
    const { type: _type, ...rest } = format;
    return { type: 'json_schema', json_schema: rest };
  }
  return format;
};

/**
 * Names of Responses `custom` tools the request translator wrapped as
 * single-string function tools. Returned alongside the translated payload so
 * the trip's events translator can project wrapped function calls back into
 * `custom_tool_call` outputs.
 */
export interface ResponsesToChatCompletionsResult {
  target: ChatCompletionsPayload;
  customToolNames: Set<string>;
}

export const translateResponsesToChatCompletions = (payload: ResponsesPayload): ResponsesToChatCompletionsResult => {
  const customToolNames = new Set<string>();
  const responseFormat = buildChatResponseFormat(payload.text);
  // Tools first so customToolNames is populated before input history processing
  // sees the same trip's tool-name set (it doesn't currently consume the set,
  // but ordering reflects the wrap-then-project flow at one place).
  const tools = translateResponseTools(payload.tools, customToolNames);
  const messages: Message[] = payload.instructions ? [{ role: 'system', content: payload.instructions }] : [];

  if (typeof payload.input === 'string') {
    messages.push({ role: 'user', content: payload.input });
  } else {
    let assistant: AssistantAccumulator | null = null;
    const flushAssistant = () => {
      if (!assistant) return;
      messages.push({
        ...assistant.message,
        ...chatReasoningProjectionFields(assistant.reasoning),
      });
      assistant = null;
    };

    for (const item of payload.input) {
      if (item.type === 'reasoning') {
        assistant = ensureAssistant(assistant);
        addResponseReasoningToChatProjection(assistant.reasoning, item);
        continue;
      }

      if (item.type === 'function_call') {
        assistant = appendAssistantToolCall(assistant, item);
        continue;
      }

      if (item.type === 'function_call_output') {
        flushAssistant();
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: item.output,
        });
        continue;
      }

      if (item.type === 'custom_tool_call') {
        // Project the freeform invocation into the wrapped function-tool shape
        // so the translated target sees a coherent tool-call history.
        assistant = appendAssistantToolCall(assistant, {
          call_id: item.call_id,
          name: item.name,
          arguments: JSON.stringify({ input: item.input }),
        });
        continue;
      }

      if (item.type === 'custom_tool_call_output') {
        flushAssistant();
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: item.output,
        });
        continue;
      }

      // item_reference items are connection-bound pointers with no inline
      // content to translate; skip them.
      if (item.type === 'item_reference') continue;

      if (item.role === 'assistant') {
        assistant = appendAssistantText(assistant, responsesContentToText(item.content));
        continue;
      }

      flushAssistant();
      messages.push({
        role: item.role,
        content: responsesContentToChatContent(item.content),
      });
    }

    flushAssistant();
  }

  // Same-purpose OpenAI fields pass through directly here, while broader
  // Responses-only state such as `previous_response_id` remains native-only.
  const target: ChatCompletionsPayload = {
    model: payload.model,
    messages,
    ...(payload.max_output_tokens !== undefined ? { max_tokens: payload.max_output_tokens } : {}),
    stream: true,
    ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
    ...(payload.store !== undefined ? { store: payload.store } : {}),
    ...(payload.parallel_tool_calls !== undefined ? { parallel_tool_calls: payload.parallel_tool_calls } : {}),
    ...(responseFormat !== undefined ? { response_format: responseFormat } : {}),
    ...(payload.prompt_cache_key !== undefined ? { prompt_cache_key: payload.prompt_cache_key } : {}),
    ...(payload.safety_identifier !== undefined ? { safety_identifier: payload.safety_identifier } : {}),
    ...(payload.reasoning?.effort != null ? { reasoning_effort: payload.reasoning.effort } : {}),
    ...(payload.service_tier !== undefined ? { service_tier: payload.service_tier } : {}),
    // Chat Completions has no request-level counterpart for Responses
    // `reasoning`; only explicit reasoning items survive this translation.
    tools,
    tool_choice: translateResponseToolChoice(payload.tool_choice),
  };

  return { target, customToolNames };
};

export const buildTargetRequest = translateResponsesToChatCompletions;
