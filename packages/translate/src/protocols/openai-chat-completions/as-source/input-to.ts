import { klona } from 'klona/json';

import { partitionOpenAIChatCompletionsTurns, type OpenAIChatCompletionsConversationMessage, type OpenAIChatCompletionsConversationTurn } from './conversation-turns.ts';
import type { OpenAIChatCompletionsSourceAssistantTurn } from './round-trip.ts';
import type { SourceReading } from '../../../composition/reading.ts';
import type {
  IRInputAssistantContentPart,
  IRInputAssistantItem,
  IRInputRequestHeader,
  IRInputSettings,
  IRInputTool,
  IRInputToolChoice,
  IRInputToolSelector,
  IRInputOutputFormat,
  IRInputTextPart,
  IRInputToolResultContentPart,
  IRInputToolResultItem,
  IRInputTurn,
  IRInputUserContentPart,
  IRInputClientItem,

} from '../../../ir/input/types.ts';
import { TranslateInputException } from '../../../shared/input-error.ts';
import type {
  OpenAIChatCompletionsNamedToolChoice,
  OpenAIChatCompletionsPayload,
  OpenAIChatCompletionsTool,
  OpenAIChatCompletionsUserContentPart,
} from '@floway-dev/protocols/openai-chat-completions';

const AUDIO_MEDIA_TYPES: Readonly<Record<string, string>> = { wav: 'audio/wav', mp3: 'audio/mp3' };

// Explicit empty user and assistant messages retain their turn boundaries.
// A caller can explicitly keep or omit an empty text part.
const textPartsToIR = (value: string, options: { keepEmpty?: boolean } = {}): IRInputTextPart[] => value === '' && options.keepEmpty === false ? [] : [{ type: 'text', text: value }];

interface OpenAIChatCompletionsInputContext {
  readonly callKinds: ReadonlyMap<string, 'function' | 'custom'>;
  readonly legacyIds: readonly (string | undefined)[];
}

// A legacy call and result correlate by name and occurrence. Reserve modern
// ids before choosing their synthetic spelling, including ids later in history.
// This inventory also advances across assistant turns restored without the IR.
const openaiChatCompletionsInputContext = (payload: OpenAIChatCompletionsPayload): OpenAIChatCompletionsInputContext => {
  const claimed = new Set(payload.messages.flatMap(message => message.role === 'assistant' ? (message.tool_calls ?? []).map(call => call.id) : []));
  const occurrences = new Map<string, string[]>();
  const calls = new Map<string, number>();
  const results = new Map<string, number>();
  const legacyIds = payload.messages.map(message => {
    const name = message.role === 'assistant' ? message.function_call?.name : message.role === 'function' ? message.name : undefined;
    if (name === undefined) return undefined;
    const counts = message.role === 'assistant' ? calls : results;
    const occurrence = counts.get(name) ?? 0;
    counts.set(name, occurrence + 1);
    let ids = occurrences.get(name);
    if (ids === undefined) { ids = []; occurrences.set(name, ids); }
    let id = ids[occurrence];
    if (id === undefined) {
      const base = `legacy__${name}__${occurrence}`;
      id = base;
      for (let suffix = 1; claimed.has(id); suffix++) id = `${base}_${suffix}`;
      claimed.add(id);
      ids[occurrence] = id;
    }
    return id;
  });
  return { callKinds: openaiChatCompletionsCallKinds(payload), legacyIds };
};

const userContentPart = (part: OpenAIChatCompletionsUserContentPart): IRInputUserContentPart => {
  switch (part.type) {
  case 'text':
    return { type: 'text', text: part.text };
  case 'image_url':
    return {
      type: 'image',
      image: { source_kind: 'url', url: part.image_url.url },
      ...(part.image_url.detail === undefined ? {} : { detail: part.image_url.detail }),
    };
  case 'input_audio':
    return { type: 'audio', audio: { media_type: AUDIO_MEDIA_TYPES[part.input_audio.format] ?? `audio/${part.input_audio.format}`, data: part.input_audio.data } };
  case 'file': {
    const filename = part.file.filename === undefined ? {} : { filename: part.file.filename };
    if (part.file.file_id !== undefined) return { type: 'file', file: { source_kind: 'file', file_id: part.file.file_id }, ...filename };
    if (part.file.file_data !== undefined) {
      return {
        type: 'file',
        file: { source_kind: 'data', data: part.file.file_data },
        ...filename,
      };
    }
    throw new TranslateInputException("A Chat Completions file part requires 'file_id' or 'file_data'.");
  }
  default:
    throw new TranslateInputException(`Invalid '${(part as { type: string }).type}' content part. Only 'text', 'image_url', 'input_audio', and 'file' are supported.`);
  }
};

// Chat's `tool` content array is transport fragments of one payload. The input IR
// keeps the parts so a target that accepts structured content can use them; a
// target that only carries strings decides how to flatten.
const toolResultContent = (content: string | readonly { text: string }[]): string | readonly IRInputToolResultContentPart[] => typeof content === 'string'
  ? content
  : content.map(part => ({ type: 'text' as const, text: part.text }));

const assistantItems = (turn: Extract<OpenAIChatCompletionsConversationTurn, { role: 'assistant' }>, context: OpenAIChatCompletionsInputContext, messageIndex: number): IRInputAssistantItem[] => {
  const message = turn.items[0];

  const content: IRInputAssistantContentPart[] = typeof message.content === 'string'
    ? textPartsToIR(message.content)
    : (message.content ?? []).map(part => part.type === 'text'
        ? { type: 'text' as const, text: part.text }
        : { type: 'refusal' as const, refusal: part.refusal });
  if (message.refusal !== undefined && message.refusal !== null) {
    content.push({ type: 'refusal', refusal: message.refusal });
  }

  // A null content with nothing else to say is an explicitly empty assistant
  // message; with tool calls or a refusal it is simply absent.
  const legacyCall = message.function_call ?? undefined;
  const emptyMessage = Array.isArray(message.content) && message.content.length === 0
    || message.content == null && message.refusal == null && (message.tool_calls?.length ?? 0) === 0 && legacyCall === undefined;
  const items: IRInputAssistantItem[] = emptyMessage
    ? [{ type: 'message', content: [{ type: 'text', text: '' }] }]
    : content.length > 0 ? [{ type: 'message', content }] : [];
  // The legacy single `function_call` field carries a call with no id. It is
  // still input a client may send, so it becomes a call with a deterministic
  // id shared with the following legacy result of the same name occurrence.
  if (legacyCall !== undefined) {
    items.push({
      type: 'function_call',
      call_id: context.legacyIds[messageIndex]!,
      name: legacyCall.name,
      arguments: legacyCall.arguments,
    });
  }
  for (const call of message.tool_calls ?? []) {
    items.push(call.type === 'custom'
      ? { type: 'custom_tool_call', call_id: call.id, name: call.custom.name, input: call.custom.input }
      : { type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
  }
  return items;
};

/**
 * Call kinds keyed by call ID. A Chat `tool` message does not state which kind
 * it answers; only the preceding assistant message's `tool_calls` do.
 */
const openaiChatCompletionsCallKinds = (payload: OpenAIChatCompletionsPayload): ReadonlyMap<string, 'function' | 'custom'> => {
  const kinds = new Map<string, 'function' | 'custom'>();
  for (const message of payload.messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.tool_calls ?? []) kinds.set(call.id, call.type === 'custom' ? 'custom' : 'function');
  }
  return kinds;
};

const openaiChatCompletionsTurnToIR = (
  turn: OpenAIChatCompletionsConversationTurn,
  context: OpenAIChatCompletionsInputContext,
  messageIndex: number,
): IRInputTurn => {
  if (turn.role === 'assistant') return { kind: 'assistant', items: assistantItems(turn, context, messageIndex) };

  return { kind: 'client', items: turn.items.flatMap((message, index) => clientItems(message, context, messageIndex + index)) };
};

const clientItems = (message: Exclude<OpenAIChatCompletionsConversationMessage, { role: 'assistant' }>, context: OpenAIChatCompletionsInputContext, messageIndex: number): IRInputClientItem[] => {
  switch (message.role) {
  case 'system':
  case 'developer':
    return [{
      type: 'message',
      role: message.role,
      // A non-text part in system/developer content has no representation on
      // any target, so it is rejected here rather than dropped silently.
      content: typeof message.content === 'string'
        ? textPartsToIR(message.content, { keepEmpty: false })
        : (message.content ?? []).map(part => {
            if (part.type !== 'text') throw new TranslateInputException(`Invalid '${part.type}' content part in system or developer message. Only 'text' content parts are supported in system messages on this model.`);
            return { type: 'text' as const, text: part.text };
          }),
    }];
  case 'user':
    return [{
      type: 'message',
      role: 'user',
      content: message.content == null ? [{ type: 'text', text: '' }] : typeof message.content === 'string' ? textPartsToIR(message.content) : message.content.map(userContentPart),
    }];
  case 'tool': {
    if (!message.tool_call_id) throw new TranslateInputException("Missing required field 'tool_call_id' on a 'tool' role message.");
    const toolKind = context.callKinds.get(message.tool_call_id);
    const result: IRInputToolResultItem = {
      type: 'tool_result',
      call_id: message.tool_call_id,
      output: toolResultContent(message.content),
      ...(toolKind === undefined ? {} : { tool_kind: toolKind }),
    };
    return [result];
  }
  case 'function':
    return [{ type: 'tool_result', call_id: context.legacyIds[messageIndex]!, output: message.content == null ? '' : toolResultContent(message.content) }];
  default:
    throw new TranslateInputException(`Invalid role '${(message as { role: string }).role}'.`);
  }
};

const toolToIR = (tool: OpenAIChatCompletionsTool): IRInputTool => {
  if (tool.type === 'custom') {
    const format = tool.custom.format;
    return {
      type: 'custom',
      name: tool.custom.name,
      ...(tool.custom.description === undefined ? {} : { description: tool.custom.description }),
      ...(format === undefined ? {} : {
        format: format.type === 'grammar'
          ? { type: 'grammar', definition: format.grammar.definition, syntax: format.grammar.syntax }
          : { type: 'text' },
      }),
    };
  }
  return {
    type: 'function',
    name: tool.function.name,
    ...(tool.function.description === undefined ? {} : { description: tool.function.description }),
    ...(tool.function.parameters === undefined ? {} : { parameters: klona(tool.function.parameters) }),
    ...(tool.function.strict == null ? {} : { strict: tool.function.strict }),
  };
};

const selectionToIR = (selection: OpenAIChatCompletionsNamedToolChoice): IRInputToolSelector => selection.type === 'custom'
  ? { type: 'custom', name: selection.custom.name }
  : { type: 'function', name: selection.function.name };

const toolChoiceToIR = (choice: NonNullable<OpenAIChatCompletionsPayload['tool_choice']>): IRInputToolChoice => {
  if (typeof choice === 'string') return choice;
  if (choice.type === 'allowed_tools') {
    return { type: 'allowed_tools', mode: choice.allowed_tools.mode, tools: choice.allowed_tools.tools.map(selectionToIR) };
  }
  return selectionToIR(choice);
};

const openaiChatCompletionsToolsToIR = (payload: OpenAIChatCompletionsPayload): Pick<IRInputRequestHeader, 'tools' | 'tool_choice'> => {
  const declarations = payload.tools ?? payload.functions?.map(fn => ({ type: 'function' as const, function: fn }));
  const tools = declarations?.map(toolToIR);
  const legacyChoice = payload.function_call;
  const choice = payload.tool_choice ?? (typeof legacyChoice === 'string'
    ? legacyChoice
    : legacyChoice === undefined ? undefined : { type: 'function' as const, function: legacyChoice });
  return {
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
    ...(choice == null ? {} : { tool_choice: toolChoiceToIR(choice) }),
  };
};

const openaiChatCompletionsRequestToIR = (payload: OpenAIChatCompletionsPayload): IRInputRequestHeader => ({
  settings: openaiChatCompletionsSettingsToIR(payload),
  ...openaiChatCompletionsToolsToIR(payload),
});

const openaiChatCompletionsSettingsToIR = (payload: OpenAIChatCompletionsPayload): IRInputSettings => {
  const format = payload.response_format;
  const outputFormat: IRInputOutputFormat | undefined = format === undefined ? undefined
    : format.type === 'json_schema'
      ? {
          type: 'json_schema',
          ...(format.json_schema.name === undefined ? {} : { name: format.json_schema.name }),
          ...(format.json_schema.description === undefined ? {} : { description: format.json_schema.description }),
          ...(format.json_schema.schema === undefined ? {} : { schema: klona(format.json_schema.schema) }),
          // The tool-side and format-side `strict` share a spelling; an omitted
          // format strictness stays absent so the target applies its own default.
          ...(format.json_schema.strict === undefined ? {} : { strict: format.json_schema.strict }),
        }
      : { type: format.type };

  return {
    model: payload.model,
    stream: payload.stream === true,
    ...(payload.temperature === undefined ? {} : { temperature: payload.temperature }),
    ...(payload.top_p === undefined ? {} : { top_p: payload.top_p }),
    ...(payload.stop == null ? {} : { stop: typeof payload.stop === 'string' ? [payload.stop] : [...payload.stop] }),
    ...(payload.seed == null ? {} : { seed: payload.seed }),
    ...(payload.max_tokens === undefined ? {} : { max_visible_output_tokens: payload.max_tokens }),
    ...(payload.max_completion_tokens === undefined ? {} : { max_output_tokens: payload.max_completion_tokens }),
    ...(outputFormat === undefined ? {} : { output_format: outputFormat }),
    ...(payload.metadata == null ? {} : { metadata: payload.metadata }),
    ...(payload.store === undefined ? {} : { store: payload.store }),
    ...(payload.service_tier == null ? {} : { service_tier: payload.service_tier }),
    ...(payload.parallel_tool_calls === undefined ? {} : { parallel_tool_calls: payload.parallel_tool_calls }),
    ...(payload.reasoning_effort == null ? {} : { reasoning_effort: payload.reasoning_effort }),
    ...(payload.prompt_cache_key === undefined ? {} : { prompt_cache_key: payload.prompt_cache_key }),
    ...(payload.prompt_cache_retention === undefined ? {} : { prompt_cache_retention: payload.prompt_cache_retention }),
    ...(payload.prompt_cache_options === undefined ? {} : { prompt_cache_options: klona(payload.prompt_cache_options) }),
    ...(payload.safety_identifier === undefined ? {} : { safety_identifier: payload.safety_identifier }),
    ...(payload.user === undefined ? {} : { user: payload.user }),
    ...(payload.logprobs === undefined ? {} : { logprobs: payload.logprobs }),
    ...(payload.top_logprobs === undefined ? {} : { top_logprobs: payload.top_logprobs }),
    ...(payload.verbosity == null ? {} : { verbosity: payload.verbosity }),
    ...(payload.n == null ? {} : { choice_count: payload.n }),
    ...(payload.presence_penalty === undefined ? {} : { presence_penalty: payload.presence_penalty }),
    ...(payload.frequency_penalty === undefined ? {} : { frequency_penalty: payload.frequency_penalty }),

  };
};

export const readOpenAIChatCompletionsRequest = (payload: OpenAIChatCompletionsPayload): SourceReading<OpenAIChatCompletionsSourceAssistantTurn> => {
  const context = openaiChatCompletionsInputContext(payload);
  let messageIndex = 0;
  return {
    request: openaiChatCompletionsRequestToIR(payload),
    turns: partitionOpenAIChatCompletionsTurns(payload.messages).map(turn => {
      const at = messageIndex;
      messageIndex += turn.items.length;
      return turn.role === 'assistant'
        ? {
            kind: 'assistant' as const,
            assistantTurn: turn.items[0],
            toIRInputTurns: () => [openaiChatCompletionsTurnToIR(turn, context, at)],
          }
        : { kind: 'client' as const, toIRInputTurns: () => [openaiChatCompletionsTurnToIR(turn, context, at)] };
    }),
  };
};
