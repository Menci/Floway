import { klona } from 'klona/json';

import { openaiResponsesContentToOpenAIChatCompletionsContent, openaiResponsesContentToText } from './content.ts';
import { roundTripAssistantTurn, warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type { SidecarCodec } from '../../../types.ts';
import { restrictAllowedTools } from '../as-source/allowed-tools.ts';
import { partitionOpenAIResponsesTurns } from '../as-source/conversation-turns.ts';
import { flattenNamespaceTools, type NamespaceToolNames } from '../as-source/namespace-tools.ts';
import { rejectProgramCaller, rejectProgrammaticOpenAIResponsesPayload } from '../as-source/programmatic-tooling.ts';
import { collectOpenAIResponsesReplayContents, findOpenAIResponsesSidecarCarriers, isOpenAIResponsesEncryptedReasoning, verifyOpenAIResponsesTurnDigest } from '../as-source/round-trip.ts';
import { canonicalizeOpenAIResponsesPayload } from '../canonicalize-payload.ts';
import { buildCustomToolInputSchema } from '../common/custom-tool-wrap.ts';
import type { OpenAIChatCompletionsAssistantMessage, OpenAIChatCompletionsResponseFormat, OpenAIChatCompletionsUserContentPart, OpenAIChatCompletionsPayload, OpenAIChatCompletionsMessage, OpenAIChatCompletionsTool, OpenAIChatCompletionsToolCall } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesCustomToolCallOutputItem, OpenAIResponsesFunctionCallOutputItem, OpenAIResponsesInputImage, CanonicalOpenAIResponsesText, CanonicalOpenAIResponsesInputItem, OpenAIResponsesPayloadEx, OpenAIResponsesRequestPayloadEx, OpenAIResponsesTool, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';

interface AssistantAccumulator {
  message: OpenAIChatCompletionsAssistantMessage;
  reasoningText?: string;
}

const ensureAssistant = (assistant: AssistantAccumulator | null): AssistantAccumulator =>
  assistant ?? {
    message: { role: 'assistant', content: null },
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

interface ToolCallOutputProjection {
  toolContent: string;
  liftedImageContent: OpenAIChatCompletionsUserContentPart[];
}

// OpenAI Chat Completions tool messages admit only strings or text parts, while OpenAI Responses tool
// output also admits images. Keep every tool result contiguous with its
// assistant tool-call group, then lift its images into one following user
// message so vision targets receive a legal, usable shape.
// https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/chat/completions/completions.ts#L1893-L1908
// https://github.com/vercel/ai/blob/c093ee7458ccd5dada05d8461041e47c24ee55c0/packages/google/src/convert-to-google-messages.ts#L137-L180
const projectToolCallOutput = (item: OpenAIResponsesFunctionCallOutputItem | OpenAIResponsesCustomToolCallOutputItem): ToolCallOutputProjection => {
  if (typeof item.output === 'string') return { toolContent: item.output, liftedImageContent: [] };
  if (item.output.some(part => part.type === 'input_file')) {
    throw new TranslatorInputError('Cannot translate input_file tool output to OpenAI Chat Completions.');
  }

  const images = item.output.filter((part): part is OpenAIResponsesInputImage => part.type === 'input_image');
  const textParts = item.output.filter((part): part is CanonicalOpenAIResponsesText =>
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
    liftedImageContent: lifted as OpenAIChatCompletionsUserContentPart[],
  };
};

const translateOpenAIResponsesTools = (tools: OpenAIResponsesTool[] | null | undefined, customToolNames: Set<string>): OpenAIChatCompletionsTool[] | undefined => {
  // After allowed_tools selection, Chat Completions can represent only flat
  // function and custom declarations. Custom tools are wrapped as functions
  // and recorded so response events can restore their freeform shape. The
  // server-tool shim rewrites hosted web_search declarations to ordinary
  // function tools before this translation, so retained shim tools need no
  // special handling here.
  const out: OpenAIChatCompletionsTool[] = [];

  for (const tool of tools ?? []) {
    if (tool.type === 'function') {
      out.push({
        type: 'function',
        function: {
          name: tool.name,
          // OpenAI Responses spells "unspecified" as an omitted key or an explicit
          // `null`; OpenAI Chat Completions has only the omitted-key spelling.
          ...(tool.parameters == null ? {} : { parameters: klona(tool.parameters) }),
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
    throw new TranslatorInputError(`Cannot translate OpenAI Responses tool type '${tool.type}' to OpenAI Chat Completions.`);
  }

  return out.length > 0 ? out : undefined;
};

const translateOpenAIResponsesToolChoice = (choice?: OpenAIResponsesToolChoice | null): OpenAIChatCompletionsPayload['tool_choice'] => {
  if (choice == null) return undefined;
  if (typeof choice === 'string') {
    if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
    throw new TranslatorInputError(`Cannot translate OpenAI Responses tool choice '${choice}' to OpenAI Chat Completions.`);
  }
  // Both function and wrapped custom tools land on the target as named function
  // choices since they share the function-tool wire shape after translation.
  if (choice.type !== 'function' && choice.type !== 'custom') throw new TranslatorInputError(`Cannot translate OpenAI Responses tool choice type '${choice.type}' to OpenAI Chat Completions.`);
  return { type: 'function', function: { name: choice.name } };
};

const buildOpenAIChatCompletionsResponseFormat = (text: OpenAIResponsesPayloadEx['text']): OpenAIChatCompletionsPayload['response_format'] | undefined => {
  if (text === undefined) return undefined;
  if (text === null) return undefined;
  // `text: {}` means no explicit format. Keep it omitted instead of converting
  // absence into an explicit OpenAI Chat Completions `response_format: null`.
  const format = klona(text.format);
  if (!Object.hasOwn(text, 'format') || format === undefined) return undefined;
  if (format === null) return undefined;
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
    return { type: 'json_schema', json_schema: rest as Extract<OpenAIChatCompletionsResponseFormat, { type: 'json_schema' }>['json_schema'] };
  }
  return format as OpenAIChatCompletionsResponseFormat;
};

export interface TargetRequestResult {
  target: OpenAIChatCompletionsPayload;
  namespaceToolNames: NamespaceToolNames;
  /**
   * Names of OpenAI Responses `custom` tools the request translator wrapped as
   * single-string function tools. Returned alongside the translated payload so
   * the trip's events translator can project wrapped function calls back into
   * `custom_tool_call` outputs.
   */
  customToolNames: Set<string>;
}

export const buildTargetRequest = async (source: OpenAIResponsesRequestPayloadEx, codec: SidecarCodec): Promise<TargetRequestResult> => {
  const canonical = canonicalizeOpenAIResponsesPayload(source);
  const { payload, names: namespaceToolNames, flattenInput } = flattenNamespaceTools(canonical);
  rejectProgrammaticOpenAIResponsesPayload(payload, 'OpenAI Chat Completions');
  const customToolNames = new Set<string>();
  const legacyFunctionNames = new Map<string, string>();
  const responseFormat = buildOpenAIChatCompletionsResponseFormat(payload.text);

  const translateAssistantTurn = (items: CanonicalOpenAIResponsesInputItem[]): OpenAIChatCompletionsMessage[] => {
    let assistant: AssistantAccumulator | null = null;
    for (const item of flattenInput(items)) {
      rejectProgramCaller(item);
      if (item.type === 'reasoning') {
        if (isOpenAIResponsesEncryptedReasoning(item)) { warnDroppedUnrecognizedAssistantReasoning('openaiResponses', 'openaiChatCompletions'); continue; }
        assistant = ensureAssistant(assistant);
        const text = item.summary.map(part => part.text).join('');
        if (text) assistant.reasoningText = (assistant.reasoningText ?? '') + text;
      } else if (item.type === 'function_call') assistant = appendAssistantToolCall(assistant, item);
      else if (item.type === 'custom_tool_call') assistant = appendAssistantToolCall(assistant, { call_id: item.call_id, name: item.name, arguments: JSON.stringify({ input: item.input }) });
      else if (item.type === 'message' && item.role === 'assistant') {
        if (Array.isArray(item.content)) {
          const unsupported = item.content.find(part => part.type === 'input_file' || part.type === 'input_image');
          if (unsupported !== undefined) throw new TranslatorInputError(`Cannot translate ${unsupported.type} assistant content to OpenAI Chat Completions.`);
        }
        assistant = appendAssistantText(assistant, openaiResponsesContentToText(item.content));
      } else throw new TranslatorInputError(`Invalid input item type '${item.type}'.`);
    }
    return assistant === null ? [] : [{ ...assistant.message, ...(assistant.reasoningText === undefined ? {} : { reasoning_text: assistant.reasoningText }) }];
  };

  const translateNonAssistantInput = (items: CanonicalOpenAIResponsesInputItem[]): OpenAIChatCompletionsMessage[] => {
    const messages: OpenAIChatCompletionsMessage[] = [];
    const pendingToolOutputImages: OpenAIChatCompletionsUserContentPart[] = [];
    const flushToolOutputImages = (): void => {
      if (pendingToolOutputImages.length === 0) return;
      messages.push({ role: 'user', content: [...pendingToolOutputImages] });
      pendingToolOutputImages.length = 0;
    };
    for (const item of flattenInput(items)) {
      if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') flushToolOutputImages();
      rejectProgramCaller(item);
      if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        const projected = projectToolCallOutput(item);
        const legacyName = legacyFunctionNames.get(item.call_id);
        legacyFunctionNames.delete(item.call_id);
        messages.push(legacyName === undefined
          ? { role: 'tool', tool_call_id: item.call_id, content: projected.toolContent }
          : { role: 'function', name: legacyName, content: projected.toolContent });
        pendingToolOutputImages.push(...projected.liftedImageContent);
      } else if (item.type === 'message' && item.role !== 'assistant') {
        if (item.role === 'user') messages.push({ role: 'user', content: openaiResponsesContentToOpenAIChatCompletionsContent(item.content) as OpenAIChatCompletionsUserContentPart[] | string });
        else {
          const content = typeof item.content === 'string' ? item.content : item.content.map(part => {
            if (part.type !== 'input_text' && part.type !== 'output_text') throw new TranslatorInputError('Only text content is supported in Chat system/developer messages.');
            return { type: 'text' as const, text: part.text };
          });
          messages.push({ role: item.role, content });
        }
      } else throw new TranslatorInputError(`Invalid input item type '${item.type}'.`);
    }
    flushToolOutputImages();
    return messages;
  };

  const allowed = restrictAllowedTools(payload.tools, payload.tool_choice);
  const tools = translateOpenAIResponsesTools(allowed.tools, customToolNames);
  // Same-purpose OpenAI fields pass through directly here, while broader
  // OpenAI-Responses-only state such as `previous_response_id` remains native-only.
  const target: OpenAIChatCompletionsPayload = {
    model: payload.model,
    messages: payload.instructions ? [{ role: 'system', content: payload.instructions }] : [],
    ...(payload.max_output_tokens !== undefined ? { max_tokens: payload.max_output_tokens } : {}),
    stream: true,
    ...(payload.temperature !== undefined ? { temperature: payload.temperature } : {}),
    ...(payload.top_p !== undefined ? { top_p: payload.top_p } : {}),
    ...(payload.metadata !== undefined ? { metadata: klona(payload.metadata) } : {}),
    ...(payload.store !== undefined ? { store: payload.store } : {}),
    ...(payload.parallel_tool_calls != null ? { parallel_tool_calls: payload.parallel_tool_calls } : {}),
    ...(responseFormat !== undefined ? { response_format: responseFormat } : {}),
    ...(payload.prompt_cache_key !== undefined ? { prompt_cache_key: payload.prompt_cache_key } : {}),
    ...(payload.safety_identifier !== undefined ? { safety_identifier: payload.safety_identifier } : {}),
    ...(payload.reasoning?.effort != null ? { reasoning_effort: payload.reasoning.effort } : {}),
    ...(payload.text?.verbosity != null ? { verbosity: payload.text.verbosity } : {}),
    ...(payload.service_tier !== undefined ? { service_tier: payload.service_tier } : {}),
    tools,
    tool_choice: translateOpenAIResponsesToolChoice(allowed.choice),
  };

  for (const turn of partitionOpenAIResponsesTurns(canonical.input)) {
    if (turn.role !== 'assistant') { target.messages.push(...translateNonAssistantInput(turn.items)); continue; }
    const roundTrip = await roundTripAssistantTurn('openaiResponses', 'openaiChatCompletions', turn.items, codec, findOpenAIResponsesSidecarCarriers, verifyOpenAIResponsesTurnDigest, collectOpenAIResponsesReplayContents);
    if (roundTrip?.turn.function_call != null) {
      const modernIds = new Set(roundTrip.turn.tool_calls?.map(call => call.id));
      for (const item of turn.items) {
        if ((item.type === 'function_call' || item.type === 'custom_tool_call') && !modernIds.has(item.call_id)) legacyFunctionNames.set(item.call_id, roundTrip.turn.function_call.name);
      }
    }
    target.messages.push(...(roundTrip ? [roundTrip.turn] : translateAssistantTurn(turn.items)));
  }
  return { target, customToolNames, namespaceToolNames };
};
