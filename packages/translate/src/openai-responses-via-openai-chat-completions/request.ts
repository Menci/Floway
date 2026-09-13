import { canonicalizeOpenAIResponsesPayload } from '../canonicalize-openai-responses-payload.ts';
import { openaiResponsesContentToOpenAIChatCompletionsContent, openaiResponsesContentToText } from '../shared/openai-chat-completions-and-openai-responses/content.ts';
import { addOpenAIResponsesReasoningToOpenAIChatCompletionsProjection, type OpenAIChatCompletionsReasoningProjection, openaiChatCompletionsReasoningProjectionFields, createOpenAIChatCompletionsReasoningProjection } from '../shared/openai-chat-completions-and-openai-responses/reasoning.ts';
import { agentMessageContent } from '../shared/openai-responses-via/agent-message.ts';
import { buildCustomToolInputSchema } from '../shared/openai-responses-via/custom-tool-wrap.ts';
import { rejectProgramCaller, rejectProgrammaticOpenAIResponsesPayload } from '../shared/openai-responses-via/programmatic-tooling.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import type { OpenAIChatCompletionsContentPart, OpenAIChatCompletionsPayload, OpenAIChatCompletionsMessage, OpenAIChatCompletionsTool, OpenAIChatCompletionsToolCall } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesFunctionCallOutputItem, OpenAIResponsesInputImage, OpenAIResponsesInputText, OpenAIResponsesPayload, OpenAIResponsesRequestPayload, OpenAIResponsesTool, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';

interface AssistantAccumulator {
  message: OpenAIChatCompletionsMessage;
  reasoning: OpenAIChatCompletionsReasoningProjection;
}

const ensureAssistant = (assistant: AssistantAccumulator | null): AssistantAccumulator =>
  assistant ?? {
    message: { role: 'assistant', content: null },
    reasoning: createOpenAIChatCompletionsReasoningProjection(),
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
    } satisfies OpenAIChatCompletionsToolCall,
  ];
  return next;
};

interface FunctionCallOutputProjection {
  toolContent: string;
  liftedImageContent: OpenAIChatCompletionsContentPart[];
}

// OpenAI Chat Completions tool messages admit only strings or text parts, while OpenAI Responses tool
// output also admits images. Keep every tool result contiguous with its
// assistant tool-call group, then lift its images into one following user
// message so vision targets receive a legal, usable shape.
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/chat/completions/completions.ts#L1893-L1908
// https://github.com/vercel/ai/blob/c093ee7458ccd5dada05d8461041e47c24ee55c0/packages/google/src/convert-to-google-messages.ts#L137-L180
const projectFunctionCallOutput = (item: OpenAIResponsesFunctionCallOutputItem): FunctionCallOutputProjection => {
  if (typeof item.output === 'string') return { toolContent: item.output, liftedImageContent: [] };
  if (item.output.some(part => part.type === 'input_file')) {
    throw new TranslatorInputError('Cannot translate input_file tool output to OpenAI Chat Completions.');
  }

  const images = item.output.filter((part): part is OpenAIResponsesInputImage => part.type === 'input_image');
  const textParts = item.output.filter((part): part is OpenAIResponsesInputText =>
    part.type === 'input_text' || part.type === 'output_text');
  if (images.length === 0) {
    return { toolContent: openaiResponsesContentToText(textParts), liftedImageContent: [] };
  }

  const lifted = openaiResponsesContentToOpenAIChatCompletionsContent([
    { type: 'input_text', text: `Image output from tool call ${item.call_id}:` },
    ...images,
  ]);
  if (typeof lifted === 'string') throw new Error('Image tool output projection lost its image content');
  return {
    toolContent: openaiResponsesContentToText(textParts) || 'Image output is attached in the following user message.',
    liftedImageContent: lifted,
  };
};

const namespaceTargetName = (namespace: string, name: string, reserved: Set<string>): string => {
  // Chat function names admit only letters, digits, underscores and dashes,
  // with a maximum of 64 characters. Reserve ordinary tool names first and
  // keep the suffix inside that limit when namespace names collide.
  // https://platform.openai.com/docs/api-reference/chat/create#chat-create-tools
  const preferred = `${namespace}_${name}`.replaceAll(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  let candidate = preferred;
  for (let suffix = 2; reserved.has(candidate); suffix++) {
    const ending = `_${suffix}`;
    candidate = `${preferred.slice(0, 64 - ending.length)}${ending}`;
  }
  reserved.add(candidate);
  return candidate;
};

const translateOpenAIResponsesTools = (
  tools: OpenAIResponsesTool[] | null | undefined,
  customToolNames: Set<string>,
  namespaceToolNames: TargetRequestResult['namespaceToolNames'],
): OpenAIChatCompletionsTool[] | undefined => {
  // Translated OpenAI Chat Completions targets do not currently have a faithful
  // bridge for hosted/deferred OpenAI Responses tools (`web_search`,
  // `tool_search`, `image_generation`, and future builtin
  // names). Native OpenAI Responses targets receive those entries unchanged; this
  // translator narrows to functions (including namespace functions) and
  // Freeform `custom` tools, recording
  // the latter in `customToolNames` so the events translator can recover
  // the freeform shape on the way back. The shim's web_search
  // function tool is in `payload.tools` under its resolved name (the shim
  // injects it on every request that uses hosted web_search) and reaches
  // here as an ordinary function tool — no special carve-out needed.
  const out: OpenAIChatCompletionsTool[] = [];
  const reservedNames = new Set((tools ?? []).flatMap(tool =>
    (tool.type === 'function' || tool.type === 'custom') && typeof tool.name === 'string' ? [tool.name] : []));

  for (const tool of tools ?? []) {
    if (tool.type === 'function') {
      out.push({
        type: 'function',
        function: {
          name: tool.name,
          // OpenAI Responses spells "unspecified" as an omitted key or an explicit
          // `null`; OpenAI Chat Completions has only the omitted-key spelling.
          ...(tool.parameters == null ? {} : { parameters: tool.parameters }),
          ...(tool.strict == null ? {} : { strict: tool.strict }),
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
      continue;
    }
    if (tool.type !== 'namespace') continue;
    if (typeof tool.name !== 'string' || !Array.isArray(tool.tools)) {
      throw new TranslatorInputError('Cannot translate a namespace tool without a string name and tools array to OpenAI Chat Completions.');
    }
    for (const child of tool.tools) {
      if (child === null || typeof child !== 'object' || (child.type !== 'function' && child.type !== 'custom')) {
        throw new TranslatorInputError(`Cannot translate unsupported child in namespace '${tool.name}' to OpenAI Chat Completions.`);
      }
      if (child.type === 'custom') {
        if (typeof child.name !== 'string') throw new TranslatorInputError(`Cannot translate malformed custom child in namespace '${tool.name}' to OpenAI Chat Completions.`);
        const targetName = namespaceTargetName(tool.name, child.name, reservedNames);
        namespaceToolNames.sourceToTarget.set(`${tool.name}.${child.name}`, targetName);
        namespaceToolNames.targetToSource.set(targetName, { namespace: tool.name, name: child.name });
        customToolNames.add(targetName);
        out.push({
          type: 'function', function: {
            name: targetName, parameters: buildCustomToolInputSchema(child.format), strict: false,
            ...(child.description ? { description: child.description } : {}),
          },
        });
        continue;
      }
      const fn = child as { name?: unknown; description?: unknown; parameters?: unknown; strict?: unknown };
      if (typeof fn.name !== 'string'
        || (fn.parameters != null && (typeof fn.parameters !== 'object' || Array.isArray(fn.parameters)))) {
        throw new TranslatorInputError(`Cannot translate malformed function child in namespace '${tool.name}' to OpenAI Chat Completions.`);
      }
      const targetName = namespaceTargetName(tool.name, fn.name, reservedNames);
      namespaceToolNames.sourceToTarget.set(`${tool.name}.${fn.name}`, targetName);
      namespaceToolNames.targetToSource.set(targetName, { namespace: tool.name, name: fn.name });
      out.push({
        type: 'function',
        function: {
          name: targetName,
          ...(fn.parameters == null ? {} : { parameters: fn.parameters as Record<string, unknown> }),
          ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
          ...(typeof fn.strict === 'boolean' ? { strict: fn.strict } : {}),
        },
      });
    }
  }

  return out.length > 0 ? out : undefined;
};

const translateOpenAIResponsesToolChoice = (
  choice: OpenAIResponsesToolChoice | null | undefined,
  namespaceSourceToTarget: ReadonlyMap<string, string>,
): OpenAIChatCompletionsPayload['tool_choice'] => {
  if (choice == null) return undefined;
  if (typeof choice === 'string') return choice;
  // Both function and wrapped custom tools land on the target as named function
  // choices since they share the function-tool wire shape after translation.
  if (choice.type !== 'function' && choice.type !== 'custom') return undefined;
  return { type: 'function', function: { name: namespaceSourceToTarget.get(choice.name) ?? choice.name } };
};

const buildOpenAIChatCompletionsResponseFormat = (text: OpenAIResponsesPayload['text']): OpenAIChatCompletionsPayload['response_format'] | undefined => {
  if (text === undefined) return undefined;
  if (text === null) return null;
  // `text: {}` means no explicit format. Keep it omitted instead of converting
  // absence into an explicit OpenAI Chat Completions `response_format: null`.
  const format = text.format;
  if (!Object.hasOwn(text, 'format') || format === undefined) return undefined;
  if (format === null) return null;
  // OpenAI Responses API uses a flat json_schema shape
  // ({ type, name, strict, schema }), while OpenAI Chat Completions wraps the
  // schema details under a nested `json_schema` field. Reshape only when
  // needed; pass `text`/`json_object` and already-wrapped variants through.
  // Without this, OpenAI Chat Completions upstreams reject the request with
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

export interface TargetRequestResult {
  target: OpenAIChatCompletionsPayload;
  /**
   * Names of OpenAI Responses `custom` tools the request translator wrapped as
   * single-string function tools. Returned alongside the translated payload so
   * the trip's events translator can project wrapped function calls back into
   * `custom_tool_call` outputs.
   */
  customToolNames: Set<string>;
  namespaceToolNames: {
    sourceToTarget: Map<string, string>;
    targetToSource: Map<string, { namespace: string; name: string }>;
  };
}

export const buildTargetRequest = (source: OpenAIResponsesRequestPayload): TargetRequestResult => {
  const payload = canonicalizeOpenAIResponsesPayload(source);
  rejectProgrammaticOpenAIResponsesPayload(payload, 'OpenAI Chat Completions');
  const customToolNames = new Set<string>();
  const namespaceToolNames: TargetRequestResult['namespaceToolNames'] = { sourceToTarget: new Map(), targetToSource: new Map() };
  const tools = translateOpenAIResponsesTools(payload.tools, customToolNames, namespaceToolNames);
  const responseFormat = buildOpenAIChatCompletionsResponseFormat(payload.text);
  const messages: OpenAIChatCompletionsMessage[] = payload.instructions ? [{ role: 'system', content: payload.instructions }] : [];
  const pendingToolOutputImages: OpenAIChatCompletionsContentPart[] = [];

  let assistant: AssistantAccumulator | null = null;
  const flushAssistant = () => {
    if (!assistant) return;
    messages.push({
      ...assistant.message,
      ...openaiChatCompletionsReasoningProjectionFields(assistant.reasoning),
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
    if (item.type === 'agent_message') {
      flushAssistant();
      messages.push({
        role: 'user',
        content: openaiResponsesContentToOpenAIChatCompletionsContent(agentMessageContent(item)),
      });
      continue;
    }

    if (item.type === 'reasoning') {
      assistant = ensureAssistant(assistant);
      addOpenAIResponsesReasoningToOpenAIChatCompletionsProjection(assistant.reasoning, item);
      continue;
    }

    if (item.type === 'function_call') {
      const sourceName = item.namespace === undefined ? item.name : `${item.namespace}.${item.name}`;
      assistant = appendAssistantToolCall(assistant, { ...item, name: namespaceToolNames.sourceToTarget.get(sourceName) ?? item.name });
      continue;
    }

    if (item.type === 'function_call_output') {
      if (typeof item.call_id !== 'string' || item.call_id.length === 0) {
        throw new TranslatorInputError('Cannot translate function_call_output without call_id to OpenAI Chat Completions.');
      }
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
        name: namespaceToolNames.sourceToTarget.get(item.namespace === undefined ? item.name : `${item.namespace}.${item.name}`) ?? item.name,
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
          throw new TranslatorInputError(`Cannot translate ${unsupported.type} assistant content to OpenAI Chat Completions.`);
        }
      }
      assistant = appendAssistantText(assistant, openaiResponsesContentToText(item.content));
      continue;
    }

    flushAssistant();
    messages.push({
      role: item.role,
      content: openaiResponsesContentToOpenAIChatCompletionsContent(item.content),
    });
  }

  flushAssistant();
  flushToolOutputImages();

  // Same-purpose OpenAI fields pass through directly here, while broader
  // OpenAI-Responses-only state such as `previous_response_id` remains native-only.
  const target: OpenAIChatCompletionsPayload = {
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
    // OpenAI Chat Completions has no request-level counterpart for OpenAI Responses
    // `reasoning`; only explicit reasoning items survive this translation.
    tools,
    tool_choice: translateOpenAIResponsesToolChoice(payload.tool_choice, namespaceToolNames.sourceToTarget),
  };

  return { target, customToolNames, namespaceToolNames };
};
