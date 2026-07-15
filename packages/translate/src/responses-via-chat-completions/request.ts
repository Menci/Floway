import { responsesContentToChatCompletionsContent, responsesContentToText } from '../shared/chat-completions-and-responses/content.ts';
import { addResponsesReasoningToChatCompletionsProjection, type ChatCompletionsReasoningProjection, chatCompletionsReasoningProjectionFields, createChatCompletionsReasoningProjection } from '../shared/chat-completions-and-responses/reasoning.ts';
import { buildCustomToolInputSchema } from '../shared/responses-via/custom-tool-wrap.ts';
import { rejectProgramCaller, rejectProgrammaticResponsesPayload } from '../shared/responses-via/programmatic-tooling.ts';
import { canonicalizeResponsesPayload } from '../shared/via-responses/responses-items.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import type { ChatCompletionsContentPart, ChatCompletionsPayload, ChatCompletionsMessage, ChatCompletionsTool, ChatCompletionsToolCall } from '@floway-dev/protocols/chat-completions';
import type { ResponsesFunctionCallOutputItem, ResponsesInputImage, ResponsesInputText, ResponsesPayload, ResponsesRequestPayload, ResponsesTool, ResponsesToolChoice } from '@floway-dev/protocols/responses';

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

interface FunctionCallOutputProjection {
  toolContent: string;
  liftedImageContent: ChatCompletionsContentPart[];
}

// Chat tool messages admit only strings or text parts, while Responses tool
// output also admits images. Keep every tool result contiguous with its
// assistant tool-call group, then lift its images into one following user
// message so vision targets receive a legal, usable shape.
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/chat/completions/completions.ts#L1893-L1908
// https://github.com/vercel/ai/blob/c093ee7458ccd5dada05d8461041e47c24ee55c0/packages/google/src/convert-to-google-messages.ts#L137-L180
const projectFunctionCallOutput = (item: ResponsesFunctionCallOutputItem): FunctionCallOutputProjection => {
  if (typeof item.output === 'string') return { toolContent: item.output, liftedImageContent: [] };
  if (item.output.some(part => part.type === 'input_file')) {
    throw new TranslatorInputError('Cannot translate input_file tool output to Chat Completions.');
  }

  const images = item.output.filter((part): part is ResponsesInputImage => part.type === 'input_image');
  const textParts = item.output.filter((part): part is ResponsesInputText =>
    part.type === 'input_text' || part.type === 'output_text');
  if (images.length === 0) {
    return { toolContent: responsesContentToText(textParts), liftedImageContent: [] };
  }

  const lifted = responsesContentToChatCompletionsContent([
    { type: 'input_text', text: `Image output from tool call ${item.call_id}:` },
    ...images,
  ]);
  if (typeof lifted === 'string') throw new Error('Image tool output projection lost its image content');
  return {
    toolContent: responsesContentToText(textParts) || 'Image output is attached in the following user message.',
    liftedImageContent: lifted,
  };
};

const translateResponsesTools = (tools: ResponsesTool[] | null | undefined, customToolNames: Set<string>): ChatCompletionsTool[] | undefined => {
  // Translated Chat Completions targets do not currently have a faithful
  // bridge for hosted/deferred Responses tools (`web_search`,
  // `tool_search`, `namespace`, `image_generation`, and future builtin
  // names). Native Responses targets receive those entries unchanged; this
  // translator narrows to function and Freeform `custom` tools, recording
  // the latter in `customToolNames` so the events translator can recover
  // the freeform shape on the way back. The shim's web_search
  // function tool is in `payload.tools` under its resolved name (the shim
  // injects it on every request that uses hosted web_search) and reaches
  // here as an ordinary function tool — no special carve-out needed.
  const out: ChatCompletionsTool[] = [];

  for (const tool of tools ?? []) {
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

const translateResponsesToolChoice = (choice?: ResponsesToolChoice | null): ChatCompletionsPayload['tool_choice'] => {
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

export const translateResponsesToChatCompletions = (source: ResponsesRequestPayload): ResponsesToChatCompletionsResult => {
  const payload = canonicalizeResponsesPayload(source);
  rejectProgrammaticResponsesPayload(payload, 'Chat Completions');
  const customToolNames = new Set<string>();
  const responseFormat = buildChatCompletionsResponseFormat(payload.text);
  const messages: ChatCompletionsMessage[] = payload.instructions ? [{ role: 'system', content: payload.instructions }] : [];
  const pendingToolOutputImages: ChatCompletionsContentPart[] = [];

  let assistant: AssistantAccumulator | null = null;
  const flushAssistant = () => {
    if (!assistant) return;
    messages.push({
      ...assistant.message,
      ...chatCompletionsReasoningProjectionFields(assistant.reasoning),
    });
    assistant = null;
  };

  const flushToolOutputImages = () => {
    if (pendingToolOutputImages.length === 0) return;
    messages.push({ role: 'user', content: [...pendingToolOutputImages] });
    pendingToolOutputImages.length = 0;
  };

  for (const item of payload.input) {
    if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') flushToolOutputImages();
    rejectProgramCaller(item);
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
      const projected = projectFunctionCallOutput(item);
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: projected.toolContent,
      });
      pendingToolOutputImages.push(...projected.liftedImageContent);
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
      if (typeof item.output !== 'string') {
        throw new TranslatorInputError(`Cannot translate multimodal custom_tool_call_output '${item.call_id}'.`);
      }
      flushAssistant();
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id,
        content: item.output,
      });
      continue;
    }

    if (item.type === 'item_reference') {
      throw new TranslatorInputError("Invalid input item type 'item_reference'.");
    }

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
      if (Array.isArray(item.content)) {
        const unsupported = item.content.find(part => part.type === 'input_file' || part.type === 'input_image');
        if (unsupported !== undefined) {
          throw new TranslatorInputError(`Cannot translate ${unsupported.type} assistant content to Chat Completions.`);
        }
      }
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
  flushToolOutputImages();

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
