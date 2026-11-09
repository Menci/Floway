import { klona } from 'klona/json';

import { validateAllowedTools } from './allowed-tools.ts';
import { partitionOpenAIResponsesTurns } from './conversation-turns.ts';
import { flattenNamespaceTools, type NamespaceToolNames } from './namespace-tools.ts';
import { rejectProgramCaller, rejectProgrammaticOpenAIResponsesPayload } from './programmatic-tooling.ts';
import { isOpenAIResponsesEncryptedReasoning } from './round-trip.ts';
import type { OpenAIResponsesAssistantTurn } from './round-trip.ts';
import type { IRInputReading } from '../../../ir/input/reading.ts';
import type {
  IRInputAssistantContentPart,
  IRInputAssistantItem,
  IRInputRequest,
  IRInputSettings,
  IRInputTool,
  IRInputToolChoice,
  IRInputOutputFormat,
  IRInputMedia,
  IRInputTextPart,
  IRInputToolResultContentPart,
  IRInputToolResultItem,
  IRInputTurn,
  IRInputUserContentPart,
  IRInputClientItem,
} from '../../../ir/input/types.ts';
import { TranslatorInputError } from '../../../types.ts';
import { canonicalizeOpenAIResponsesPayload } from '../canonicalize-payload.ts';
import type {
  CanonicalOpenAIResponsesInputItem,
  CanonicalOpenAIResponsesPayload,
  OpenAIResponsesInputContent,
  OpenAIResponsesInputMessageEx,
  OpenAIResponsesRequestPayloadEx,
  OpenAIResponsesTool,
} from '@floway-dev/protocols/openai-responses';

const DATA_URL = /^data:([^;,]+)?;base64,(.*)$/s;

const mediaFromUrl = (url: string): IRInputMedia => {
  const dataUrl = DATA_URL.exec(url);
  if (dataUrl === null) return { source_kind: 'url', url };
  const mediaType = dataUrl[1]?.trim();
  return { source_kind: 'base64', ...(mediaType === undefined || mediaType === '' ? {} : { media_type: mediaType }), data: dataUrl[2] };
};

const imageMedia = (part: Extract<OpenAIResponsesInputContent, { type: 'input_image' }>): IRInputMedia => {
  if (typeof part.image_url === 'string') return mediaFromUrl(part.image_url);
  if (typeof part.file_id === 'string') return { source_kind: 'file', file_id: part.file_id };
  throw new TranslatorInputError('An OpenAI Responses input_image requires image_url or file_id.');
};

const fileMedia = (part: Extract<OpenAIResponsesInputContent, { type: 'input_file' }>): IRInputMedia => {
  if (typeof part.file_id === 'string') return { source_kind: 'file', file_id: part.file_id };
  if (typeof part.file_url === 'string') return { source_kind: 'url', url: part.file_url };
  if (typeof part.file_data === 'string') {
    // `file_data` is either raw base64 or a data URL; a data URL also states the
    // media type a target may need.
    const dataUrl = DATA_URL.exec(part.file_data);
    if (dataUrl === null) return { source_kind: 'base64', data: part.file_data };
    const mediaType = dataUrl[1]?.trim();
    return { source_kind: 'base64', ...(mediaType === undefined || mediaType === '' ? {} : { media_type: mediaType }), data: dataUrl[2] };
  }
  throw new TranslatorInputError('An OpenAI Responses input_file requires file_id, file_url, or file_data.');
};

const userContentPart = (part: OpenAIResponsesInputContent): IRInputUserContentPart => {
  switch (part.type) {
  case 'input_text':
  case 'output_text':
    return { type: 'text', text: part.text };
  case 'input_image': {
    const image = imageMedia(part);
    return { type: 'image', image, ...(part.detail == null ? {} : { detail: part.detail }) };
  }
  case 'input_file':
    return { type: 'file', file: fileMedia(part), ...(typeof part.filename === 'string' ? { filename: part.filename } : {}) };
  }
};

const userContent = (content: string | OpenAIResponsesInputContent[]): IRInputUserContentPart[] => typeof content === 'string'
  ? content === '' ? [] : [{ type: 'text', text: content }]
  : content.map(userContentPart);

const systemContent = (message: OpenAIResponsesInputMessageEx): IRInputTextPart[] => typeof message.content === 'string'
  ? message.content === '' ? [] : [{ type: 'text', text: message.content }]
  : message.content.map(part => {
      if (part.type !== 'input_text' && part.type !== 'output_text') {
        throw new TranslatorInputError(`Invalid '${part.type}' content part in ${message.role} message. Only 'input_text' content parts are supported in ${message.role} messages on this model.`);
      }
      return { type: 'text', text: part.text };
    });

// An explicitly empty assistant message still occupies a message of its own, so
// it keeps one empty text part; only a message with no content field at all has
// nothing to replay.
const assistantContent = (message: Extract<OpenAIResponsesInputMessageEx, { role: 'assistant' }>): IRInputAssistantContentPart[] => typeof message.content === 'string'
  ? [{ type: 'text', text: message.content }]
  : message.content.map(part => {
      if (part.type === 'input_text' || part.type === 'output_text') return { type: 'text' as const, text: part.text };
      // An assistant turn replays model output, so a refusal it produced is
      // history like any other part.
      if (part.type === 'refusal') return { type: 'refusal' as const, refusal: part.refusal };
      throw new TranslatorInputError(`Cannot translate ${part.type} assistant content.`);
    });

const toolResultContent = (output: string | readonly OpenAIResponsesInputContent[]): string | readonly IRInputToolResultContentPart[] => typeof output === 'string'
  ? output
  : output.map(part => {
      if (part.type === 'input_image') return { type: 'image' as const, image: imageMedia(part), ...(part.detail == null ? {} : { detail: part.detail }) };
      if (part.type === 'input_file') return { type: 'file' as const, file: fileMedia(part), ...(typeof part.filename === 'string' ? { filename: part.filename } : {}) };
      return { type: 'text' as const, text: part.text };
    });

const unsupportedItem = (item: CanonicalOpenAIResponsesInputItem): never => {
  throw new TranslatorInputError(`Invalid input item: ${JSON.stringify(item)}`);
};

const assistantItems = (items: readonly CanonicalOpenAIResponsesInputItem[]): IRInputAssistantItem[] => items.map((item): IRInputAssistantItem | undefined => {
  rejectProgramCaller(item);
  switch (item.type) {
  case 'message': {
    if (item.role !== 'assistant') throw new TranslatorInputError(`Invalid assistant message role '${item.role}'.`);
    const content = assistantContent(item);
    // An empty assistant message has nothing to replay.
    return content.length === 0 ? undefined : { type: 'message' as const, content };
  }
  case 'reasoning':
    // An encrypted carrier is the sidecar's material: it is authenticated
    // against the issuing deployment and means nothing to another vendor.
    if (isOpenAIResponsesEncryptedReasoning(item)) return undefined;
    {
      const summary = item.summary.map(part => part.text);
      const content = (item.content ?? []).map(part => part.text);
      // No readable text means nothing any target could replay.
      if (summary.length === 0 && content.length === 0) return undefined;
      return { type: 'reasoning' as const, ...(summary.length === 0 ? {} : { summary }), ...(content.length === 0 ? {} : { content }) };
    }
  case 'function_call':
    return { type: 'function_call' as const, call_id: item.call_id, name: item.name, arguments: item.arguments };
  case 'custom_tool_call':
    return { type: 'custom_tool_call' as const, call_id: item.call_id, name: item.name, input: item.input };
  case 'item_reference':
  case 'web_search_call':
  case 'image_generation_call':
    return unsupportedItem(item);
  default:
    unsupportedItem(item);
  }
}).filter((item): item is IRInputAssistantItem => item !== undefined);

const userItems = (items: readonly CanonicalOpenAIResponsesInputItem[]): IRInputClientItem[] => items.flatMap((item): IRInputClientItem[] => {
  rejectProgramCaller(item);
  switch (item.type) {
  case 'message':
    switch (item.role) {
    case 'user': return [{ type: 'message' as const, content: userContent(item.content) }];
    case 'system':
    case 'developer': return [{ type: 'prompt' as const, role: item.role, content: systemContent(item) }];
    default: throw new TranslatorInputError(`Invalid role '${item.role}' in input message.`);
    }
  case 'function_call_output': {
    const result: IRInputToolResultItem = {
      type: 'tool_result',
      call_id: item.call_id,
      output: toolResultContent(item.output),
      tool_kind: 'function',
      ...(item.status === 'incomplete' ? { is_error: true } : {}),
    };
    return [result];
  }
  case 'custom_tool_call_output':
    return [{
      type: 'tool_result' as const,
      call_id: item.call_id,
      output: toolResultContent(item.output),
      tool_kind: 'custom' as const,
    }];
  default:
    return unsupportedItem(item);
  }
});

/** Whether a turn carries an encrypted reasoning carrier the input IR cannot hold. */
/** The top-level `instructions` field as its own leading system item. */
const openaiResponsesInstructionsToIR = (instructions: string | null | undefined): IRInputTurn | undefined => instructions
  ? { kind: 'client', items: [{ type: 'prompt', role: 'system', content: [{ type: 'text', text: instructions }] }] }
  : undefined;

const openaiResponsesTurnToIR = (
  turn: { readonly role: 'assistant' | 'bare'; readonly items: readonly CanonicalOpenAIResponsesInputItem[] },
  flattenInput: (input: readonly CanonicalOpenAIResponsesInputItem[]) => CanonicalOpenAIResponsesInputItem[],
): IRInputTurn[] => {
  const items = flattenInput(turn.items);
  if (turn.role !== 'assistant') return [{ kind: 'client', items: userItems(items) }];
  // Every assistant item was dropped (an opaque reasoning carrier, say). The
  // turn carried a boundary that must survive, so writers still see it as a
  // separator but emit no message for it.
  return [{ kind: 'assistant', items: assistantItems(items) }];
};

/**
 * Responses states the ceiling once, as `max_output_tokens`. Its `text.format`
 * carries the structured-output schema flat, unlike Chat's nested spelling.
 */
// Responses declares flat function and custom tools beside the hosted kinds.
// A hosted tool runs on the vendor's own infrastructure and has no meaning in
// another protocol, so a request that carries one cannot enter this IR.
const toolToIR = (tool: OpenAIResponsesTool): IRInputTool => {
  if (tool.type === 'custom') {
    const format = tool.format as { type?: unknown; definition?: unknown; syntax?: unknown } | undefined;
    return {
      type: 'custom',
      name: tool.name,
      ...(tool.description == null ? {} : { description: tool.description }),
      ...(format === undefined || typeof format.type !== 'string' ? {} : {
        format: format.type === 'grammar' && typeof format.definition === 'string'
          ? { type: 'grammar', definition: format.definition, syntax: String(format.syntax ?? '') }
          : { type: 'text' },
      }),
    };
  }
  if (tool.type !== 'function') throw new TranslatorInputError(`Cannot translate OpenAI Responses tool type '${tool.type}'.`);
  return {
    type: 'function',
    name: tool.name,
    ...(tool.description == null ? {} : { description: tool.description }),
    ...(tool.parameters == null ? {} : { parameters: klona(tool.parameters) }),
    ...(tool.strict == null ? {} : { strict: tool.strict }),
  };
};

const toolChoiceToIR = (choice: NonNullable<CanonicalOpenAIResponsesPayload['tool_choice']>): IRInputToolChoice => {
  if (typeof choice === 'string') {
    if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
    // A hosted selector spells its arm as a bare string, and names a tool this
    // IR does not carry.
    throw new TranslatorInputError(`Cannot translate OpenAI Responses tool choice '${choice}'.`);
  }
  if (choice.type === 'allowed_tools') {
    return {
      type: 'allowed_tools',
      mode: choice.mode,
      tools: choice.tools.map(selection => {
        const named = selection as { type: string; name?: unknown };
        return { type: named.type === 'custom' ? 'custom' as const : 'function' as const, name: String(named.name ?? '') };
      }),
    };
  }
  if (choice.type === 'function' || choice.type === 'custom') return { type: choice.type, name: choice.name };
  // A hosted selector names a tool this IR does not carry.
  throw new TranslatorInputError(`Cannot translate OpenAI Responses tool choice type '${choice.type}'.`);
};

const openaiResponsesToolsToIR = (payload: CanonicalOpenAIResponsesPayload): Pick<IRInputRequest, 'tools' | 'tool_choice'> => {
  const tools = payload.tools?.map(toolToIR);
  const toolChoice = payload.tool_choice == null ? undefined : toolChoiceToIR(payload.tool_choice);
  return {
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  };
};

const openaiResponsesSettingsToIR = (payload: CanonicalOpenAIResponsesPayload): IRInputSettings => {
  const format = payload.text?.format;
  const outputFormat: IRInputOutputFormat | undefined = format === undefined || format === null ? undefined
    : format.type === 'json_schema'
      ? {
        // A caller may hand the Chat-Completions-nested spelling to the
        // Responses field; its details are still the same schema.
          ...('json_schema' in format && typeof format.json_schema === 'object' && format.json_schema !== null
            ? format.json_schema as Record<string, unknown>
            : {}),
          type: 'json_schema',
          ...('name' in format && typeof format.name === 'string' ? { name: format.name } : {}),
          ...('description' in format && typeof format.description === 'string' ? { description: format.description } : {}),
          ...('schema' in format && format.schema !== undefined && format.schema !== null && typeof format.schema === 'object'
            ? { schema: klona(format.schema) as Record<string, unknown> }
            : {}),
          ...('strict' in format && typeof format.strict === 'boolean' ? { strict: format.strict } : {}),
        }
      : { type: format.type };

  return {
    model: payload.model,
    stream: payload.stream === true,
    ...(payload.temperature == null ? {} : { temperature: payload.temperature }),
    ...(payload.top_p == null ? {} : { top_p: payload.top_p }),
    ...(payload.max_output_tokens == null ? {} : { max_output_tokens: payload.max_output_tokens }),
    ...(outputFormat === undefined ? {} : { output_format: outputFormat }),
    ...(payload.metadata == null ? {} : { metadata: payload.metadata }),
    ...(payload.store == null ? {} : { store: payload.store }),
    ...(payload.service_tier == null ? {} : { service_tier: payload.service_tier }),
    ...(payload.parallel_tool_calls == null ? {} : { parallel_tool_calls: payload.parallel_tool_calls }),
    ...(payload.reasoning?.effort == null ? {} : { reasoning_effort: payload.reasoning.effort }),
    ...(payload.prompt_cache_key === undefined ? {} : { prompt_cache_key: payload.prompt_cache_key }),
    ...(payload.safety_identifier === undefined ? {} : { safety_identifier: payload.safety_identifier }),
    ...(payload.text?.verbosity == null ? {} : { verbosity: payload.text.verbosity }),
  };
};

/**
 * What reading a Responses request accumulated for the client-side writer.
 *
 * Flattening assigns a flat name per namespaced callable, and it keeps
 * assigning as history is read, so the final map depends on how many turns the
 * reading walked. Deriving it again from the request afterwards would stop at
 * the declarations and miss every name history allocated.
 */
export interface OpenAIResponsesDerived {
  readonly namespaceToolNames: NamespaceToolNames;
}

export const openaiResponsesRead = (source: OpenAIResponsesRequestPayloadEx): IRInputReading<OpenAIResponsesAssistantTurn, OpenAIResponsesDerived> => {
  const canonical = canonicalizeOpenAIResponsesPayload(source);
  const { payload, names, flattenInput } = flattenNamespaceTools(canonical);
  validateAllowedTools(payload.tools, payload.tool_choice, payload.input);
  rejectProgrammaticOpenAIResponsesPayload(payload, 'translation');

  const prompt = openaiResponsesInstructionsToIR(payload.instructions);
  return {
    request: {
      conversation: { turns: [] },
      settings: openaiResponsesSettingsToIR(payload),
      ...openaiResponsesToolsToIR(payload),
    },
    turns: [
      ...(prompt === undefined ? [] : [{ kind: 'client' as const, toIRTurn: () => [prompt] }]),
      ...partitionOpenAIResponsesTurns(canonical.input).map(turn => turn.role === 'assistant'
        ? {
            kind: 'assistant' as const,
            assistantTurn: turn.items,
            toIRTurn: () => openaiResponsesTurnToIR(turn, flattenInput),
          }
        : { kind: 'client' as const, toIRTurn: () => openaiResponsesTurnToIR(turn, flattenInput) }),
    ],
    derived: { namespaceToolNames: names },
  };
};
