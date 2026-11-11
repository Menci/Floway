import { klona } from 'klona/json';

import { requireCallableSelector } from './allowed-tools.ts';
import { partitionOpenAIResponsesTurns, type OpenAIResponsesConversationTurn } from './conversation-turns.ts';
import { rejectProgramCaller, rejectProgrammaticOpenAIResponsesPayload } from './programmatic-tooling.ts';
import type { OpenAIResponsesSourceAssistantTurn } from './round-trip.ts';
import type { SourceReading } from '../../../composition/reading.ts';
import { mediaFromURL, mediaOrThrow } from '../../../ir/input/media.ts';
import type {
  IRInputAssistantContentPart,
  IRInputAssistantItem,
  IRInputRequestHeader,
  IRInputSettings,
  IRInputTool,
  IRInputToolChoice,
  IRInputToolSelector,
  IRInputOutputFormat,
  IRInputMedia,
  IRInputTextPart,
  IRInputToolResultContentPart,
  IRInputToolResultItem,
  IRInputTurn,
  IRInputUserContentPart,
  IRInputClientItem,
} from '../../../ir/input/types.ts';
import { TranslateInputException } from '../../../shared/input-error.ts';
import { requireCanonicalOpenAIResponsesPayload } from '../canonicalize-payload.ts';
import type {
  CanonicalOpenAIResponsesInputItem,
  CanonicalOpenAIResponsesPayload,
  OpenAIResponsesInputContent,
  OpenAIResponsesInputMessageEx,
  OpenAIResponsesRequestPayloadEx,
  OpenAIResponsesTool,
} from '@floway-dev/protocols/openai-responses';

const imageMedia = (part: Extract<OpenAIResponsesInputContent, { type: 'input_image' }>): IRInputMedia => {
  if (typeof part.image_url === 'string') return mediaOrThrow(mediaFromURL(part.image_url), part.image_url);
  if (typeof part.file_id === 'string') return { source_kind: 'file', file_id: part.file_id };
  throw new TranslateInputException('An OpenAI Responses input_image requires image_url or file_id.');
};

const fileMedia = (part: Extract<OpenAIResponsesInputContent, { type: 'input_file' }>): IRInputMedia => {
  if (typeof part.file_id === 'string') return { source_kind: 'file', file_id: part.file_id };
  if (typeof part.file_url === 'string') return { source_kind: 'url', url: part.file_url };
  if (typeof part.file_data === 'string') {
    // `file_data` is either raw base64 or a data URL; a data URL also states the
    // media type a target may need. A data URL this cannot decode is not raw
    // base64 — labelling it so would send the URL text itself as the payload.
    const media = mediaFromURL(part.file_data);
    if (media === undefined) throw new TranslateInputException('An OpenAI Responses input_file states a data URL this translation cannot decode.');
    return media.source_kind === 'base64' ? media : { source_kind: 'base64', data: part.file_data };
  }
  throw new TranslateInputException('An OpenAI Responses input_file requires file_id, file_url, or file_data.');
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

const promptPartsToIR = (message: OpenAIResponsesInputMessageEx): IRInputTextPart[] => typeof message.content === 'string'
  ? message.content === '' ? [] : [{ type: 'text', text: message.content }]
  : message.content.map(part => {
      if (part.type !== 'input_text' && part.type !== 'output_text') {
        throw new TranslateInputException(`Invalid '${part.type}' content part in ${message.role} message. Only 'input_text' content parts are supported in ${message.role} messages on this model.`);
      }
      return { type: 'text', text: part.text };
    });

// A string content is stated as one text part, even `''`, because that is a
// message the wire spelled out. An array content keeps exactly the parts it
// lists, so an empty array yields no part and the caller drops the message.
const assistantContent = (message: Extract<OpenAIResponsesInputMessageEx, { role: 'assistant' }>): IRInputAssistantContentPart[] => typeof message.content === 'string'
  ? [{ type: 'text', text: message.content }]
  : message.content.map(part => {
      if (part.type === 'input_text' || part.type === 'output_text') return { type: 'text' as const, text: part.text };
      // An assistant turn replays model output, so a refusal it produced is
      // history like any other part.
      if (part.type === 'refusal') return { type: 'refusal' as const, refusal: part.refusal };
      throw new TranslateInputException(`Cannot translate ${part.type} assistant content.`);
    });

const toolResultContent = (output: string | readonly OpenAIResponsesInputContent[]): string | readonly IRInputToolResultContentPart[] => typeof output === 'string'
  ? output
  : output.map(part => {
      if (part.type === 'input_image') return { type: 'image' as const, image: imageMedia(part), ...(part.detail == null ? {} : { detail: part.detail }) };
      if (part.type === 'input_file') return { type: 'file' as const, file: fileMedia(part), ...(typeof part.filename === 'string' ? { filename: part.filename } : {}) };
      return { type: 'text' as const, text: part.text };
    });

const unsupportedItem = (item: CanonicalOpenAIResponsesInputItem): never => {
  throw new TranslateInputException(`Invalid input item: ${JSON.stringify(item)}`);
};

const assistantItems = (items: readonly CanonicalOpenAIResponsesInputItem[]): IRInputAssistantItem[] => items.map((item): IRInputAssistantItem | undefined => {
  rejectProgramCaller(item);
  switch (item.type) {
  case 'message': {
    if (item.role !== 'assistant') throw new TranslateInputException(`Invalid assistant message role '${item.role}'.`);
    const content = assistantContent(item);
    // An explicitly empty assistant message still occupies a turn: dropping it
    // would put the client runs on either side next to each other, and every
    // target that combines adjacent same-role messages would merge them.
    return { type: 'message' as const, content };
  }
  case 'reasoning':
  {
    const summary = item.summary.map(part => part.text);
    const content = (item.content ?? []).map(part => part.text);
    // No readable text means nothing any target could replay.
    if (summary.length === 0 && content.length === 0) return undefined;
    return { type: 'reasoning' as const, ...(summary.length === 0 ? {} : { summary }), ...(content.length === 0 ? {} : { content }) };
  }
  case 'function_call':
    return { type: 'function_call' as const, call_id: item.call_id, name: item.name, ...('namespace' in item && typeof item.namespace === 'string' ? { namespace: item.namespace } : {}), arguments: item.arguments };
  case 'custom_tool_call':
    return { type: 'custom_tool_call' as const, call_id: item.call_id, name: item.name, ...('namespace' in item && typeof item.namespace === 'string' ? { namespace: item.namespace } : {}), input: item.input };
  case 'item_reference':
  case 'web_search_call':
  case 'image_generation_call':
    return unsupportedItem(item);
  default:
    unsupportedItem(item);
  }
}).filter((item): item is IRInputAssistantItem => item !== undefined);

const clientItems = (items: readonly CanonicalOpenAIResponsesInputItem[]): IRInputClientItem[] => items.flatMap((item): IRInputClientItem[] => {
  rejectProgramCaller(item);
  switch (item.type) {
  case 'message':
    switch (item.role) {
    case 'user': return [{ type: 'message' as const, content: userContent(item.content) }];
    case 'system':
    case 'developer': return [{ type: 'prompt' as const, role: item.role, content: promptPartsToIR(item) }];
    default: throw new TranslateInputException(`Invalid role '${item.role}' in input message.`);
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
      ...(item.status === 'incomplete' ? { is_error: true } : {}),
    }];
  // A deferred inventory states declarations, which the request's tool list
  // already carries; it is not something the model said.
  case 'additional_tools':
  case 'tool_search_output':
    return [];
  default:
    return unsupportedItem(item);
  }
});

/** The top-level `instructions` field as its own leading system item. */
const openaiResponsesInstructionsToIR = (instructions: string | null | undefined): IRInputTurn | undefined => instructions
  ? { kind: 'client', items: [{ type: 'prompt', role: 'system', content: [{ type: 'text', text: instructions }] }] }
  : undefined;

const openaiResponsesTurnToIR = (turn: OpenAIResponsesConversationTurn): IRInputTurn[] => {
  const items = turn.items;
  if (turn.role !== 'assistant') return [{ kind: 'client', items: clientItems(items) }];
  // Every assistant item was dropped (an opaque reasoning carrier, say). The
  // turn carried a boundary that must survive, so writers still see it as a
  // separator but emit no message for it.
  return [{ kind: 'assistant', items: assistantItems(items) }];
};

// Responses declares flat function and custom tools beside the hosted kinds.
// A hosted tool runs on the vendor's own infrastructure and has no meaning in
// another protocol, so a request that carries one cannot enter this IR.
const toolToIR = (tool: Extract<OpenAIResponsesTool, { type: 'function' | 'custom' }>, namespace?: string): IRInputTool => {
  // A declaration this protocol groups states its group beside the name inside
  // it, and every other protocol reads that pair as the callable's identity.
  const group = namespace ?? ('namespace' in tool && typeof tool.namespace === 'string' ? tool.namespace : undefined);
  const identity = group === undefined ? {} : { namespace: group };
  if (tool.type === 'custom') {
    const format = tool.format as { type?: unknown; definition?: unknown; syntax?: unknown } | undefined;
    return {
      type: 'custom',
      name: tool.name,
      ...identity,
      ...(tool.description == null ? {} : { description: tool.description }),
      ...(format === undefined || typeof format.type !== 'string' ? {} : {
        format: format.type === 'grammar' && typeof format.definition === 'string'
          ? { type: 'grammar', definition: format.definition, syntax: String(format.syntax ?? '') }
          : { type: 'text' },
      }),
    };
  }
  return {
    type: 'function',
    name: tool.name,
    ...identity,
    ...(tool.description == null ? {} : { description: tool.description }),
    ...(tool.parameters == null ? {} : { parameters: klona(tool.parameters) }),
    ...(tool.strict == null ? {} : { strict: tool.strict }),
  };
};

const selectionToIR = (selection: IRInputToolSelector, declarations: readonly IRInputTool[]): IRInputToolSelector => {
  if (selection.namespace !== undefined) return selection;
  if (declarations.some(tool => tool.type === selection.type && tool.namespace === undefined && tool.name === selection.name)) return selection;
  const qualified = declarations.filter(tool => tool.type === selection.type && tool.namespace !== undefined
    && (selection.name === `${tool.namespace}.${tool.name}` || selection.name === `${tool.namespace}__${tool.name}`));
  const first = qualified[0];
  if (first === undefined) return selection;
  if (qualified.some(tool => tool.namespace !== first.namespace || tool.name !== first.name)) {
    throw new TranslateInputException(`Cannot translate ambiguous tool selector '${selection.name}'.`);
  }
  return { type: selection.type, name: first.name, namespace: first.namespace };
};

// A selector may name a whole group, which selects each callable it holds.
const selectorOf = (payload: CanonicalOpenAIResponsesPayload, selector: Record<string, unknown>, declarations: readonly IRInputTool[]): IRInputToolSelector[] => {
  if (typeof selector !== 'object' || selector?.type !== 'namespace') return [selectionToIR(requireCallableSelector(selector), declarations)];
  const groups = [
    ...(payload.tools ?? []),
    ...payload.input.flatMap(item => item.type === 'additional_tools' || item.type === 'tool_search_output' ? item.tools : []),
  ].flatMap(tool => tool.type === 'namespace' && tool.name === selector.name ? [tool] : []);
  if (groups.length === 0) throw new TranslateInputException(`Cannot translate group selector '${String(selector.name)}' without a matching declaration.`);
  return groups.flatMap(group => group.tools.flatMap(child => child.type === 'function' || child.type === 'custom'
    ? [{ type: child.type, name: child.name, namespace: group.name } as IRInputToolSelector]
    : []));
};

const toolChoiceToIR = (payload: CanonicalOpenAIResponsesPayload, declarations: readonly IRInputTool[]): IRInputToolChoice => {
  const choice = payload.tool_choice;
  if (choice == null) throw new TranslateInputException('Cannot translate a missing tool choice.');
  if (typeof choice === 'string') {
    if (choice === 'auto' || choice === 'none' || choice === 'required') return choice;
    // Any other bare string is a hosted selector, which names a callable this
    // IR does not carry.
    throw new TranslateInputException(`Cannot translate OpenAI Responses tool choice '${choice}'.`);
  }
  if (choice.type === 'allowed_tools') {
    if ((choice.mode !== 'auto' && choice.mode !== 'required') || !Array.isArray(choice.tools)) {
      throw new TranslateInputException('Cannot translate malformed allowed_tools mode or tools array.');
    }
    const tools = choice.tools.flatMap(selector => selectorOf(payload, selector, declarations));
    for (const selector of tools) {
      if (!declarations.some(tool => tool.type === selector.type && tool.namespace === selector.namespace && tool.name === selector.name)) {
        throw new TranslateInputException(`Cannot translate allowed_tools selector '${selector.name}' without a matching callable declaration.`);
      }
    }
    if (tools.length === 0 && choice.mode === 'required') {
      throw new TranslateInputException('Cannot translate required allowed_tools with an empty callable subset.');
    }
    return { type: 'allowed_tools', mode: choice.mode, tools };
  }
  if (choice.type === 'function' || choice.type === 'custom') return selectionToIR(choice, declarations);
  // A hosted selector names a tool this IR does not carry.
  throw new TranslateInputException(`Cannot translate OpenAI Responses tool choice type '${choice.type}'.`);
};

// A group is a declaration container, not a callable: this IR carries the
// callables it holds, each stating the group it belongs to, so a target that
// has no groups can still spell it out.
const toolGroupToIR = (tool: OpenAIResponsesTool): IRInputTool[] => {
  if (tool.type === 'namespace') {
    return tool.tools.flatMap(child => {
      if (child.type !== 'function' && child.type !== 'custom') {
        throw new TranslateInputException(`Cannot translate non-callable child in namespace '${tool.name}'.`);
      }
      // A group's own description qualifies each child's, the way one merged
      // declaration states it.
      const childDescription = child.description ?? undefined;
      return [toolToIR(
        tool.description === undefined
          ? child
          : { ...child, description: childDescription === undefined ? tool.description : `${tool.description}\n\n${childDescription}` },
        tool.name,
      )];
    });
  }
  if (tool.type === 'function' || tool.type === 'custom') return [toolToIR(tool)];
  throw new TranslateInputException(`Cannot translate OpenAI Responses tool type '${tool.type}'.`);
};

// A request can defer declarations to an inventory item inside the
// conversation; those are tools like any other, not things the model said.
const deferredInventories = (payload: CanonicalOpenAIResponsesPayload): OpenAIResponsesTool[] =>
  payload.input.flatMap(item => item.type === 'additional_tools' || item.type === 'tool_search_output' ? item.tools : []);

const openaiResponsesToolsToIR = (payload: CanonicalOpenAIResponsesPayload): Pick<IRInputRequestHeader, 'tools' | 'tool_choice'> => {
  const declared = payload.tools?.flatMap(toolGroupToIR) ?? [];
  const deferred = deferredInventories(payload).flatMap(toolGroupToIR);
  const tools = declared.length === 0 && deferred.length === 0 ? undefined : [...declared, ...deferred];
  const toolChoice = payload.tool_choice == null ? undefined : toolChoiceToIR(payload, tools ?? []);
  return {
    ...(tools === undefined ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  };
};

/**
 * Responses states the ceiling once, as `max_output_tokens`. Its `text.format`
 * carries the structured-output schema flat, unlike Chat's nested spelling.
 */
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
    ...(payload.presence_penalty == null ? {} : { presence_penalty: payload.presence_penalty }),
    ...(payload.frequency_penalty == null ? {} : { frequency_penalty: payload.frequency_penalty }),
    ...(payload.max_output_tokens == null ? {} : { max_output_tokens: payload.max_output_tokens }),
    ...(outputFormat === undefined ? {} : { output_format: outputFormat }),
    ...(payload.metadata == null ? {} : { metadata: payload.metadata }),
    ...(payload.store == null ? {} : { store: payload.store }),
    ...(payload.service_tier == null ? {} : { service_tier: payload.service_tier }),
    ...(payload.parallel_tool_calls == null ? {} : { parallel_tool_calls: payload.parallel_tool_calls }),
    ...(payload.reasoning?.effort == null ? {} : { reasoning_effort: payload.reasoning.effort }),
    ...(payload.reasoning?.summary == null ? {} : { reasoning_summary: payload.reasoning.summary }),
    ...(payload.prompt_cache_key === undefined ? {} : { prompt_cache_key: payload.prompt_cache_key }),
    ...(payload.safety_identifier === undefined ? {} : { safety_identifier: payload.safety_identifier }),
    ...(payload.text?.verbosity == null ? {} : { verbosity: payload.text.verbosity }),
  };
};

export const readOpenAIResponsesRequest = (source: OpenAIResponsesRequestPayloadEx): SourceReading<OpenAIResponsesSourceAssistantTurn> => {
  const canonical = requireCanonicalOpenAIResponsesPayload(source);
  rejectProgrammaticOpenAIResponsesPayload(canonical);

  const prompt = openaiResponsesInstructionsToIR(canonical.instructions);
  return {
    request: {
      settings: openaiResponsesSettingsToIR(canonical),
      ...openaiResponsesToolsToIR(canonical),
    },
    turns: [
      ...(prompt === undefined ? [] : [{ kind: 'client' as const, toIRInputTurns: () => [prompt] }]),
      ...partitionOpenAIResponsesTurns(canonical.input).map(turn => turn.role === 'assistant'
        ? {
            kind: 'assistant' as const,
            assistantTurn: turn.items,
            toIRInputTurns: () => openaiResponsesTurnToIR(turn),
          }
        : { kind: 'client' as const, toIRInputTurns: () => openaiResponsesTurnToIR(turn) }),
    ],
  };
};
