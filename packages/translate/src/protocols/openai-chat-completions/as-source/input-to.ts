import { klona } from 'klona/json';

import { partitionOpenAIChatCompletionsTurns, type OpenAIChatCompletionsConversationMessage, type OpenAIChatCompletionsConversationTurn } from './conversation-turns.ts';
import type { OpenAIChatCompletionsAssistantTurn } from './round-trip.ts';
import type { IRInputReading } from '../../../ir/input/reading.ts';
import type {
  IRInputAssistantContentPart,
  IRInputAssistantItem,
  IRInputRequest,
  IRInputSettings,
  IRInputTool,
  IRInputToolChoice,
  IRInputToolSelection,
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
import type {
  OpenAIChatCompletionsNamedToolChoice,
  OpenAIChatCompletionsPayload,
  OpenAIChatCompletionsTool,
  OpenAIChatCompletionsUserContentPart,
  OpenAIChatCompletionsStreamOptionsEx,
} from '@floway-dev/protocols/openai-chat-completions';

const DATA_URL = /^data:([^;,]+)?;base64,(.*)$/s;

// Chat Completions names an audio container while the other protocols name a
// MIME type. The input IR keeps the MIME type so a Chat source can reach GenerateContent.
const AUDIO_MEDIA_TYPES: Readonly<Record<string, string>> = { wav: 'audio/wav', mp3: 'audio/mp3' };

const mediaFromUrl = (url: string): IRInputMedia => {
  const dataUrl = DATA_URL.exec(url);
  if (dataUrl === null) return { source_kind: 'url', url };
  const mediaType = dataUrl[1]?.trim();
  return { source_kind: 'base64', ...(mediaType === undefined || mediaType === '' ? {} : { media_type: mediaType }), data: dataUrl[2] };
};

// An explicitly empty user or assistant message still occupies a native
// message of its own, so those keep one empty text part. An empty system run
// contributes nothing to the system prompt and is dropped instead.
const textParts = (value: string, keepEmpty = true): IRInputTextPart[] => value === '' && !keepEmpty ? [] : [{ type: 'text', text: value }];

// A legacy call states only its name, so its identity is the name plus which
// occurrence of that name it is. Both the call and its result take the id from
// the same counter, so they correlate without a wire id.
const legacyCallId = (name: string, occurrence: number): string => `legacy__${name}__${occurrence}`;

// Reader-side state over the whole payload: a Chat `tool` message does not say
// which call kind it answers, and a legacy result names its call by function
// name alone. Both are recovered here, before the IR states them per item.
interface OpenAIChatCompletionsInputContext {
  readonly callKinds: ReadonlyMap<string, 'function' | 'custom'>;
  // Occurrences of each legacy function name consumed so far, so a repeated
  // name yields a distinct id per call and a distinct id per result.
  readonly legacyCalls: Map<string, number>;
  readonly legacyResults: Map<string, number>;
}

const openaiChatCompletionsInputContext = (payload: OpenAIChatCompletionsPayload): OpenAIChatCompletionsInputContext => ({
  callKinds: openaiChatCompletionsCallKinds(payload),
  legacyCalls: new Map<string, number>(),
  legacyResults: new Map<string, number>(),
});

const takeOccurrence = (counts: Map<string, number>, name: string): number => {
  const occurrence = counts.get(name) ?? 0;
  counts.set(name, occurrence + 1);
  return occurrence;
};

const userContentPart = (part: OpenAIChatCompletionsUserContentPart): IRInputUserContentPart => {
  switch (part.type) {
  case 'text':
    return { type: 'text', text: part.text };
  case 'image_url':
    return {
      type: 'image',
      image: mediaFromUrl(part.image_url.url),
      ...(part.image_url.detail === undefined ? {} : { detail: part.image_url.detail }),
    };
  case 'input_audio':
    return { type: 'audio', audio: { media_type: AUDIO_MEDIA_TYPES[part.input_audio.format] ?? `audio/${part.input_audio.format}`, data: part.input_audio.data } };
  case 'file': {
    const filename = part.file.filename === undefined ? {} : { filename: part.file.filename };
    if (part.file.file_id !== undefined) return { type: 'file', file: { source_kind: 'file', file_id: part.file.file_id }, ...filename };
    if (part.file.file_data !== undefined) return { type: 'file', file: { source_kind: 'base64', data: part.file.file_data }, ...filename };
    throw new TranslatorInputError("A Chat Completions file part requires 'file_id' or 'file_data'.");
  }
  default:
    throw new TranslatorInputError(`Invalid '${(part as { type: string }).type}' content part. Only 'text', 'image_url', 'input_audio', and 'file' are supported.`);
  }
};

// Chat's `tool` content array is transport fragments of one payload. The input IR
// keeps the parts so a target that accepts structured content can use them; a
// target that only carries strings decides how to flatten.
const toolResultContent = (content: string | readonly { text: string }[]): string | readonly IRInputToolResultContentPart[] => typeof content === 'string'
  ? content
  : content.map(part => ({ type: 'text' as const, text: part.text }));

const assistantItems = (turn: Extract<OpenAIChatCompletionsConversationTurn, { role: 'assistant' }>, context: OpenAIChatCompletionsInputContext): IRInputAssistantItem[] => {
  const message = turn.items[0];

  const content: IRInputAssistantContentPart[] = typeof message.content === 'string'
    ? textParts(message.content)
    : (message.content ?? []).map(part => part.type === 'text'
        ? { type: 'text' as const, text: part.text }
        : { type: 'refusal' as const, refusal: part.refusal });
  if (message.refusal !== undefined && message.refusal !== null && !content.some(part => part.type === 'refusal')) {
    content.push({ type: 'refusal', refusal: message.refusal });
  }

  // A null content with nothing else to say is an explicitly empty assistant
  // message; with tool calls or a refusal it is simply absent.
  const legacyCall = message.function_call ?? undefined;
  const emptyMessage = message.content == null && message.refusal == null && (message.tool_calls?.length ?? 0) === 0 && legacyCall === undefined;
  const items: IRInputAssistantItem[] = emptyMessage
    ? [{ type: 'message', content: [{ type: 'text', text: '' }] }]
    : content.length > 0 ? [{ type: 'message', content }] : [];
  // The legacy single `function_call` field carries a call with no id. It is
  // still input a client may send, so it becomes a call with a deterministic
  // id that a following legacy `role: 'function'` result recomputes from the
  // same name occurrence.
  if (legacyCall !== undefined) {
    items.push({
      type: 'function_call',
      call_id: legacyCallId(legacyCall.name, takeOccurrence(context.legacyCalls, legacyCall.name)),
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
): IRInputTurn => {
  if (turn.role === 'assistant') return { kind: 'assistant', items: assistantItems(turn, context) };

  // Every client message in one turn contributes its items, in order, to the
  // same IR turn; a target that groups them differently reads the item list.
  return { kind: 'client', items: turn.items.flatMap(message => userItems(message, context)) };
};

const userItems = (message: Exclude<OpenAIChatCompletionsConversationMessage, { role: 'assistant' }>, context: OpenAIChatCompletionsInputContext): IRInputClientItem[] => {
  switch (message.role) {
  case 'system':
  case 'developer':
    return [{
      type: 'prompt',
      role: message.role,
      // A non-text part in system/developer content has no representation on
      // any target, so it is rejected here rather than dropped silently.
      content: typeof message.content === 'string'
        ? textParts(message.content, false)
        : (message.content ?? []).map(part => {
            if (part.type !== 'text') throw new TranslatorInputError(`Invalid '${part.type}' content part in system or developer message. Only 'text' content parts are supported in system messages on this model.`);
            return { type: 'text' as const, text: part.text };
          }),
    }];
  case 'user':
    return [{
      type: 'message',
      content: message.content == null ? [{ type: 'text', text: '' }] : typeof message.content === 'string' ? textParts(message.content) : message.content.map(userContentPart),
    }];
  case 'tool': {
    if (!message.tool_call_id) throw new TranslatorInputError("Missing required field 'tool_call_id' on a 'tool' role message.");
    const toolKind = context.callKinds.get(message.tool_call_id);
    const result: IRInputToolResultItem = {
      type: 'tool_result',
      call_id: message.tool_call_id,
      output: toolResultContent(message.content),
      ...(toolKind === undefined ? {} : { tool_kind: toolKind }),
    };
    return [result];
  }
  // A legacy result answers the legacy call of the same name; the id it
  // recomputes is the one the reader gave that call.
  case 'function':
    return [{ type: 'tool_result', call_id: legacyCallId(message.name, takeOccurrence(context.legacyResults, message.name)), output: message.content == null ? '' : toolResultContent(message.content) }];
  default:
    throw new TranslatorInputError(`Invalid role '${(message as { role: string }).role}'.`);
  }
};

/**
 * Chat Completions states one ceiling under two names. `max_tokens` predates
 * reasoning models; `max_completion_tokens` is its replacement and counts hidden
 * reasoning tokens as well. A request that states both is collapsed to the wider
 * bound, which is the ceiling the caller asked for.
 *
 * https://help.openai.com/en/articles/5072518-controlling-the-length-of-openai-model-responses
 * https://community.openai.com/t/why-was-max-tokens-changed-to-max-completion-tokens/938077
 */
// A Chat declaration states a function with a nested definition, a freeform
// custom tool, or a hosted tool this IR does not carry (an interceptor rewrites
// those before translation). Only the two callable arms are representable.
const toolToIR = (tool: OpenAIChatCompletionsTool): IRInputTool | undefined => {
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

const selectionToIR = (selection: OpenAIChatCompletionsNamedToolChoice): IRInputToolSelection => selection.type === 'custom'
  ? { type: 'custom', name: selection.custom.name }
  : { type: 'function', name: selection.function.name };

const toolChoiceToIR = (choice: NonNullable<OpenAIChatCompletionsPayload['tool_choice']>): IRInputToolChoice => {
  if (typeof choice === 'string') return choice;
  if (choice.type === 'allowed_tools') {
    return { type: 'allowed_tools', mode: choice.allowed_tools.mode, tools: choice.allowed_tools.tools.map(selectionToIR) };
  }
  return selectionToIR(choice);
};

const openaiChatCompletionsToolsToIR = (payload: OpenAIChatCompletionsPayload): Pick<IRInputRequest, 'tools' | 'tool_choice'> => {
  const tools = payload.tools?.map(toolToIR).filter((tool): tool is IRInputTool => tool !== undefined);
  return {
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
    ...(payload.tool_choice == null ? {} : { tool_choice: toolChoiceToIR(payload.tool_choice) }),
  };
};

const openaiChatCompletionsRequestToIR = (payload: OpenAIChatCompletionsPayload): IRInputRequest => ({
  conversation: { turns: [] },
  settings: openaiChatCompletionsSettingsToIR(payload),
  ...openaiChatCompletionsToolsToIR(payload),
});

const continuousUsageOf = (payload: OpenAIChatCompletionsPayload): boolean => {
  const streamOptions = payload.stream_options as OpenAIChatCompletionsStreamOptionsEx | undefined;
  return streamOptions?.include_usage === true && streamOptions.continuous_usage_stats === true;
};

const openaiChatCompletionsSettingsToIR = (payload: OpenAIChatCompletionsPayload): IRInputSettings => {
  const ceiling = payload.max_completion_tokens ?? payload.max_tokens;

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
          ...(format.json_schema.strict == null ? {} : { strict: format.json_schema.strict }),
        }
      : { type: format.type };

  return {
    model: payload.model,
    stream: payload.stream === true,
    ...(payload.temperature == null ? {} : { temperature: payload.temperature }),
    ...(payload.top_p == null ? {} : { top_p: payload.top_p }),
    ...(payload.stop == null ? {} : { stop: typeof payload.stop === 'string' ? [payload.stop] : [...payload.stop] }),
    ...(payload.seed == null ? {} : { seed: payload.seed }),
    ...(ceiling == null ? {} : { max_output_tokens: ceiling }),
    ...(outputFormat === undefined ? {} : { output_format: outputFormat }),
    ...(payload.metadata == null ? {} : { metadata: payload.metadata }),
    ...(payload.store == null ? {} : { store: payload.store }),
    ...(payload.service_tier == null ? {} : { service_tier: payload.service_tier }),
    ...(payload.parallel_tool_calls == null ? {} : { parallel_tool_calls: payload.parallel_tool_calls }),
    ...(payload.reasoning_effort == null ? {} : { reasoning_effort: payload.reasoning_effort }),
    ...(payload.prompt_cache_key === undefined ? {} : { prompt_cache_key: payload.prompt_cache_key }),
    ...(payload.safety_identifier === undefined ? {} : { safety_identifier: payload.safety_identifier }),
    ...(payload.verbosity == null ? {} : { verbosity: payload.verbosity }),
    ...(payload.n == null ? {} : { candidate_count: payload.n }),
    ...(payload.presence_penalty == null ? {} : { presence_penalty: payload.presence_penalty }),
    ...(payload.frequency_penalty == null ? {} : { frequency_penalty: payload.frequency_penalty }),
    // `include_usage` alone asks for the final report; the vLLM/SGLang extension
    // asks for one on every chunk. Both are the client's own rendering choice,
    // so the field states what it asked for and a target never receives it.
    // https://github.com/vllm-project/vllm/blob/d5f0a6e829faa69d1db289bf62b14dae136c02b2/vllm/entrypoints/openai/serving_engine.py#L112-L121
    ...(continuousUsageOf(payload) === false ? {} : { continuous_usage: true }),
  };
};

/**
 * A Chat Completions request prepared for translation.
 *
 * Reading a Chat conversation is stateful: a `tool` message does not state the
 * kind of call it answers, so the reader tracks which calls it has already
 * seen, and the legacy `function` role correlates by name and occurrence.
 * Presenting the request, the conversation, and the reader that carries that
 * state together keeps the state with the code that needs it.
 */
export const openaiChatCompletionsRead = (payload: OpenAIChatCompletionsPayload): IRInputReading<OpenAIChatCompletionsAssistantTurn> => {
  const context = openaiChatCompletionsInputContext(payload);
  return {
    request: openaiChatCompletionsRequestToIR(payload),
    turns: partitionOpenAIChatCompletionsTurns(payload.messages).map(turn => turn.role === 'assistant'
      ? {
          kind: 'assistant' as const,
          assistantTurn: turn.items[0],
          toIRTurn: () => [openaiChatCompletionsTurnToIR(turn, context)],
        }
      : { kind: 'client' as const, toIRTurn: () => [openaiChatCompletionsTurnToIR(turn, context)] }),
  };
};
