import { responsesContentToChatCompletionsContent, responsesContentToText } from '../shared/chat-completions-and-responses/content.ts';
import { addResponsesReasoningToChatCompletionsProjection, type ChatCompletionsReasoningProjection, chatCompletionsReasoningProjectionFields, createChatCompletionsReasoningProjection } from '../shared/chat-completions-and-responses/reasoning.ts';
import { buildCustomToolInputSchema } from '../shared/responses-via/custom-tool-wrap.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import type { ChatCompletionsPayload, ChatCompletionsMessage, ChatCompletionsTool, ChatCompletionsToolCall } from '@floway-dev/protocols/chat-completions';
import { flattenToolSearchFamilyTools, type ResponsesPayload, type ResponsesTool, type ResponsesToolChoice } from '@floway-dev/protocols/responses';

interface AssistantAccumulator {
  message: ChatCompletionsMessage;
  reasoning: ChatCompletionsReasoningProjection;
}

const ensureAssistant = (assistant: AssistantAccumulator | null): AssistantAccumulator =>
  assistant ?? {
    message: { role: 'assistant', content: null },
    reasoning: createChatCompletionsReasoningProjection(),
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
    } satisfies ChatCompletionsToolCall,
  ];
  return next;
};

const translateResponsesTools = (tools: ResponsesTool[] | null | undefined, customToolNames: Set<string>): ChatCompletionsTool[] | undefined => {
  // The Chat Completions wire has no analogue for the gpt-5.4+ tool_search
  // feature family (hosted `tool_search` / `programmatic_tool_calling`
  // entries; `namespace` container groupings; `defer_loading` /
  // `allowed_callers` fields). Desugar unconditionally via
  // `flattenToolSearchFamilyTools`: hosted family entries are dropped,
  // `namespace` containers are expanded into flat sub-tools (with sub-tool
  // names prefixed `<namespace>__` — the response-side events translator
  // strips the prefix back, mirroring `withUnprefixNamespaceToolCalls` on
  // the native path), and `defer_loading` / `allowed_callers` are stripped.
  //
  // Leaf hosted tools (`web_search`, `image_generation`) fall through — no
  // sub-tools to expand, no faithful bridge onto Chat Completions. The
  // shim's web_search function tool arrives here under its resolved name
  // as an ordinary function tool (the shim injects it on every request
  // that uses hosted web_search) — no special carve-out needed. Freeform
  // `custom` tools are wrapped as single-string function tools and their
  // names recorded in `customToolNames` so the events translator can
  // recover the `custom_tool_call` shape on the way back.
  const flat = flattenToolSearchFamilyTools(tools ?? []);
  const out: ChatCompletionsTool[] = [];

  for (const tool of flat) {
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

const translateResponsesToolChoice = (choice?: ResponsesToolChoice): ChatCompletionsPayload['tool_choice'] => {
  if (choice == null) return undefined;
  if (typeof choice === 'string') return choice;
  // Both function and wrapped custom tools land on the target as named function
  // choices since they share the function-tool wire shape after translation.
  if (choice.type !== 'function' && choice.type !== 'custom') return undefined;
  return { type: 'function', function: { name: choice.name } };
};

const buildChatCompletionsResponseFormat = (text: ResponsesPayload['text']): ChatCompletionsPayload['response_format'] | undefined => {
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
  // Without this, Chat Completions upstreams reject the request with
  // "When response_format type is 'json_schema', the 'json_schema' field
  // must be provided".
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
  const responseFormat = buildChatCompletionsResponseFormat(payload.text);
  const messages: ChatCompletionsMessage[] = payload.instructions ? [{ role: 'system', content: payload.instructions }] : [];

  if (typeof payload.input === 'string') {
    messages.push({ role: 'user', content: payload.input });
  } else {
    let assistant: AssistantAccumulator | null = null;
    const flushAssistant = () => {
      if (!assistant) return;
      messages.push({
        ...assistant.message,
        ...chatCompletionsReasoningProjectionFields(assistant.reasoning),
      });
      assistant = null;
    };

    for (const item of payload.input) {
      if (item.type === 'reasoning') {
        assistant = ensureAssistant(assistant);
        addResponsesReasoningToChatCompletionsProjection(assistant.reasoning, item);
        continue;
      }

      if (item.type === 'function_call') {
        assistant = appendAssistantToolCall(assistant, item);
        continue;
      }

      if (item.type === 'function_call_output') {
        flushAssistant();
        // FIXME: a multimodal function_call_output becomes a tool-role message
        // with image_url content parts. Verify GitHub Copilot's chat upstream
        // accepts image content on tool messages before relying on this path.
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id,
          content: responsesContentToChatCompletionsContent(item.output),
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

      // The shim must translate echoed web_search_call input items
      // into function_call + function_call_output pairs before this
      // translator runs. Reaching here means the reverse path was
      // skipped.
      if (item.type === 'web_search_call') {
        throw new TranslatorInputError("Invalid input item type 'web_search_call'.");
      }

      if (item.type !== 'message') {
        throw new TranslatorInputError(`Invalid input item type '${item.type}'.`);
      }

      if (item.role === 'assistant') {
        assistant = appendAssistantText(assistant, responsesContentToText(item.content));
        continue;
      }

      flushAssistant();
      messages.push({
        role: item.role,
        content: responsesContentToChatCompletionsContent(item.content),
      });
    }

    flushAssistant();
  }

  const tools = translateResponsesTools(payload.tools, customToolNames);
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
    ...(payload.text?.verbosity != null ? { verbosity: payload.text.verbosity } : {}),
    ...(payload.service_tier !== undefined ? { service_tier: payload.service_tier } : {}),
    // Chat Completions has no request-level counterpart for Responses
    // `reasoning`; only explicit reasoning items survive this translation.
    tools,
    tool_choice: translateResponsesToolChoice(payload.tool_choice),
  };

  return { target, customToolNames };
};

export const buildTargetRequest = translateResponsesToChatCompletions;
