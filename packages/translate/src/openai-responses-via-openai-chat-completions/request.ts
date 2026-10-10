import { klona } from 'klona/json';

import { canonicalizeOpenAIResponsesPayload } from '../canonicalize-openai-responses-payload.ts';
import {
  cleanOpenAIResponsesAssistantTurn,
  inspectOpenAIResponsesAssistantTurn,
  partitionOpenAIResponsesTurns,
  prepareIRRoundTripAssistantTurn,
  verifyOpenAIResponsesReplayCheck,
  type OpenAIResponsesAssistantTurn,
  type PreparedIRRoundTripAssistantTurn,
} from '../shared/ir/round-trip/index.ts';
import { openaiResponsesContentToOpenAIChatCompletionsContent, openaiResponsesContentToText } from '../shared/openai-chat-completions-and-openai-responses/content.ts';
import { addOpenAIResponsesReasoningToOpenAIChatCompletionsProjection, type OpenAIChatCompletionsReasoningProjection, openaiChatCompletionsReasoningProjectionFields, createOpenAIChatCompletionsReasoningProjection } from '../shared/openai-chat-completions-and-openai-responses/reasoning.ts';
import { restrictAllowedTools } from '../shared/openai-responses-via/allowed-tools.ts';
import { buildCustomToolInputSchema } from '../shared/openai-responses-via/custom-tool-wrap.ts';
import { flattenNamespaceTools, type NamespaceToolNames } from '../shared/openai-responses-via/namespace-tools.ts';
import { rejectProgramCaller, rejectProgrammaticOpenAIResponsesPayload } from '../shared/openai-responses-via/programmatic-tooling.ts';
import { TranslatorInputError } from '../translator-input-error.ts';
import type { AssistantTurnSidecarCodec } from '../types.ts';
import type { OpenAIChatCompletionsAssistantMessage, OpenAIChatCompletionsResponseFormat, OpenAIChatCompletionsUserContentPart, OpenAIChatCompletionsPayload, OpenAIChatCompletionsMessage, OpenAIChatCompletionsTool, OpenAIChatCompletionsToolCall } from '@floway-dev/protocols/openai-chat-completions';
import type { OpenAIResponsesCustomToolCallOutputItem, OpenAIResponsesFunctionCallOutputItem, OpenAIResponsesInputImage, CanonicalOpenAIResponsesText, CanonicalOpenAIResponsesInputItem, CanonicalOpenAIResponsesPayload, OpenAIResponsesPayloadEx, OpenAIResponsesRequestPayloadEx, OpenAIResponsesTool, OpenAIResponsesToolChoice } from '@floway-dev/protocols/openai-responses';

interface AssistantAccumulator {
  message: OpenAIChatCompletionsAssistantMessage;
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
    }
  }

  return out.length > 0 ? out : undefined;
};

const translateOpenAIResponsesToolChoice = (choice?: OpenAIResponsesToolChoice | null): OpenAIChatCompletionsPayload['tool_choice'] => {
  if (choice == null) return undefined;
  if (typeof choice === 'string') return choice;
  // Both function and wrapped custom tools land on the target as named function
  // choices since they share the function-tool wire shape after translation.
  if (choice.type !== 'function' && choice.type !== 'custom') return undefined;
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

type PreparedResponsesAssistantTurn = PreparedIRRoundTripAssistantTurn<OpenAIResponsesAssistantTurn, 'openaiChatCompletions'>;
type RestoredChatAssistantTurn = Extract<PreparedResponsesAssistantTurn, { kind: 'target' }>['turn'];

interface RestoredResponsesAssistantTurn { sourceCount: number; turn: RestoredChatAssistantTurn }

const buildTargetRequestFromPayload = (
  payload: CanonicalOpenAIResponsesPayload,
  namespaceToolNames: NamespaceToolNames,
  restoredTurns: ReadonlyMap<number, RestoredResponsesAssistantTurn>,
): TargetRequestResult => {
  rejectProgrammaticOpenAIResponsesPayload(payload, 'OpenAI Chat Completions');
  const customToolNames = new Set<string>();
  const responseFormat = buildOpenAIChatCompletionsResponseFormat(payload.text);
  const messages: OpenAIChatCompletionsMessage[] = payload.instructions ? [{ role: 'system', content: payload.instructions }] : [];
  const pendingToolOutputImages: OpenAIChatCompletionsUserContentPart[] = [];

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

  for (let itemIndex = 0; itemIndex < payload.input.length; itemIndex++) {
    const restored = restoredTurns.get(itemIndex);
    if (restored !== undefined) {
      flushToolOutputImages();
      flushAssistant();
      messages.push(restored.turn as OpenAIChatCompletionsMessage);
      itemIndex += restored.sourceCount - 1;
      continue;
    }
    const item = payload.input[itemIndex];
    if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') flushToolOutputImages();
    rejectProgramCaller(item);
    if (item.type === 'reasoning') {
      assistant = ensureAssistant(assistant);
      addOpenAIResponsesReasoningToOpenAIChatCompletionsProjection(assistant.reasoning, item);
      continue;
    }

    if (item.type === 'function_call') {
      assistant = appendAssistantToolCall(assistant, item);
      continue;
    }

    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      flushAssistant();
      const projected = projectToolCallOutput(item);
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
    if (item.role === 'user') messages.push({ role: 'user', content: openaiResponsesContentToOpenAIChatCompletionsContent(item.content) as OpenAIChatCompletionsUserContentPart[] | string });
    else {
      if (Array.isArray(item.content) && item.content.some(part => part.type !== 'input_text' && part.type !== 'output_text')) throw new TranslatorInputError('Only text content is supported in Chat system/developer messages.');
      messages.push({ role: item.role, content: typeof item.content === 'string' ? item.content : item.content.map(part => ({ type: 'text', text: (part as CanonicalOpenAIResponsesText).text })) });
    }
  }

  flushAssistant();
  flushToolOutputImages();

  const allowed = restrictAllowedTools(payload.tools, payload.tool_choice);
  const tools = translateOpenAIResponsesTools(allowed.tools, customToolNames);
  // Same-purpose OpenAI fields pass through directly here, while broader
  // OpenAI-Responses-only state such as `previous_response_id` remains native-only.
  const target: OpenAIChatCompletionsPayload = {
    model: payload.model,
    messages,
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

  return { target, customToolNames, namespaceToolNames };
};

export const buildTargetRequest = (source: OpenAIResponsesRequestPayloadEx): TargetRequestResult => {
  const { payload, names: namespaceToolNames } = flattenNamespaceTools(canonicalizeOpenAIResponsesPayload(source));
  return buildTargetRequestFromPayload(payload, namespaceToolNames, new Map());
};

export const buildRoundTripTargetRequest = async (source: OpenAIResponsesRequestPayloadEx, codec: AssistantTurnSidecarCodec): Promise<TargetRequestResult> => {
  const canonical = canonicalizeOpenAIResponsesPayload(source);
  const input: CanonicalOpenAIResponsesInputItem[] = [];
  const replayBySanitizedStart = new Map<number, RestoredResponsesAssistantTurn>();
  for (const turn of partitionOpenAIResponsesTurns(canonical.input)) {
    if (turn.role !== 'assistant') {
      input.push(...turn.items);
      continue;
    }
    const prepared = await prepareIRRoundTripAssistantTurn(
      'openaiResponses',
      'openaiChatCompletions',
      turn.items,
      codec,
      inspectOpenAIResponsesAssistantTurn,
      verifyOpenAIResponsesReplayCheck,
      cleanOpenAIResponsesAssistantTurn,
    );
    if (prepared.kind === 'target') {
      replayBySanitizedStart.set(input.length, { sourceCount: turn.items.length, turn: prepared.turn });
      input.push(...turn.items);
    } else input.push(...prepared.turn as CanonicalOpenAIResponsesInputItem[]);
  }

  const flattenedReplayTurns = new Map<number, RestoredResponsesAssistantTurn>();
  let inputIndex = 0;
  let flattenedIndex = 0;
  while (inputIndex < input.length) {
    const restored = replayBySanitizedStart.get(inputIndex);
    if (restored !== undefined) {
      flattenedReplayTurns.set(flattenedIndex, restored);
      inputIndex += restored.sourceCount;
      flattenedIndex += restored.sourceCount;
      continue;
    }
    const item = input[inputIndex++];
    if (item.type === 'additional_tools' || item.type === 'tool_search_output') continue;
    flattenedIndex++;
  }

  const { payload, names: namespaceToolNames } = flattenNamespaceTools({ ...canonical, input });
  return buildTargetRequestFromPayload(payload, namespaceToolNames, flattenedReplayTurns);
};
