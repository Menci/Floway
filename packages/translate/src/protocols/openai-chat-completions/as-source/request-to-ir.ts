import type {
  IRInputAssistantContentPart,
  IRInputAssistantItem,
  IRInputConversation,
  IRInputMedia,
  IRInputTextPart,
  IRInputToolResultContentPart,
  IRInputToolResultItem,
  IRInputTurn,
  IRInputUserContentPart,
  IRInputUserItem,
} from '../../../ir/input.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import { partitionOpenAIChatCompletionsTurns, type OpenAIChatCompletionsConversationTurn } from './conversation-turns.ts';
import { hasOpenAIChatCompletionsReasoning } from './round-trip.ts';
import type { OpenAIChatCompletionsContentPart, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

const DATA_URL = /^data:([^;,]+)?;base64,(.*)$/s;

// Chat Completions names an audio container while the other protocols name a
// MIME type. The IR keeps the MIME type so a Chat source can reach GenerateContent.
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

const userContentPart = (part: OpenAIChatCompletionsContentPart): IRInputUserContentPart => {
  switch (part.type) {
  case 'text':
    return { type: 'text', text: part.text };
  case 'refusal':
    return { type: 'refusal', refusal: part.refusal };
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
    throw new TranslatorInputError(`Invalid '${(part as { type: string }).type}' content part. Only 'text', 'image_url', 'input_audio', 'file', and 'refusal' are supported.`);
  }
};

const toolResultContent = (content: string | readonly { text: string }[]): string | readonly IRInputToolResultContentPart[] => typeof content === 'string'
  ? content
  : content.map(part => ({ type: 'text' as const, text: part.text }));

const assistantItems = (turn: Extract<OpenAIChatCompletionsConversationTurn, { role: 'assistant' }>): IRInputAssistantItem[] => {
  const message = turn.items[0];

  const content: IRInputAssistantContentPart[] = typeof message.content === 'string'
    ? textParts(message.content)
    : (message.content ?? []).map(part => part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : { type: 'refusal' as const, refusal: part.refusal });
  if (message.refusal !== undefined && message.refusal !== null && !content.some(part => part.type === 'refusal')) {
    content.push({ type: 'refusal', refusal: message.refusal });
  }

  const items: IRInputAssistantItem[] = content.length > 0 ? [{ type: 'message', content }] : [];
  // The legacy single `function_call` field and the `tool_calls` array carry
  // the same concept; the IR keeps only the modern spelling.
  if (message.function_call !== undefined && message.function_call !== null) {
    throw new TranslatorInputError('Cannot translate the legacy function_call field; supply tool_calls instead.');
  }
  for (const call of message.tool_calls ?? []) {
    items.push(call.type === 'custom'
      ? { type: 'custom_tool_call', call_id: call.id, name: call.custom.name, input: call.custom.input }
      : { type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
  }
  return items;
};

/**
 * Chat Completions assistant history may carry reasoning under provider
 * extension aliases with no wire contract. A reader cannot tell which alias a
 * provider meant, so it emits no reasoning item; the route reports the loss.
 */
export const openaiChatCompletionsDropsReasoning = (turn: OpenAIChatCompletionsConversationTurn): boolean =>
  turn.role === 'assistant' && hasOpenAIChatCompletionsReasoning(turn.items[0]);

/**
 * Call kinds keyed by call ID. A Chat `tool` message does not state which kind
 * it answers; only the preceding assistant message's `tool_calls` do.
 */
export const openaiChatCompletionsCallKinds = (payload: OpenAIChatCompletionsPayload): ReadonlyMap<string, 'function' | 'custom'> => {
  const kinds = new Map<string, 'function' | 'custom'>();
  for (const message of payload.messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.tool_calls ?? []) kinds.set(call.id, call.type === 'custom' ? 'custom' : 'function');
  }
  return kinds;
};

export const openaiChatCompletionsTurnToIR = (
  turn: OpenAIChatCompletionsConversationTurn,
  callKinds: ReadonlyMap<string, 'function' | 'custom'>,
): IRInputTurn => {
  if (turn.role === 'assistant') return { role: 'assistant', items: assistantItems(turn) };

  const message = turn.items[0];
  switch (message.role) {
  case 'system':
  case 'developer':
    return {
      role: 'user',
      items: [{
        type: 'message',
        role: message.role,
        // A non-text part in system/developer content has no representation on
        // any target, so it is rejected here rather than dropped silently.
        content: typeof message.content === 'string'
          ? textParts(message.content, false)
          : (message.content ?? []).map(part => {
            if (part.type !== 'text') throw new TranslatorInputError(`Invalid '${part.type}' content part in system or developer message. Only 'text' content parts are supported in system messages on this model.`);
            return { type: 'text' as const, text: part.text };
          }),
      }],
    };
  case 'user':
    return {
      role: 'user',
      items: [{
        type: 'message',
        role: 'user',
        content: message.content == null ? [{ type: 'text', text: '' }] : typeof message.content === 'string' ? textParts(message.content) : message.content.map(userContentPart),
      }],
    };
  case 'tool': {
    if (!message.tool_call_id) throw new TranslatorInputError("Missing required field 'tool_call_id' on a 'tool' role message.");
    const toolKind = callKinds.get(message.tool_call_id);
    const result: IRInputToolResultItem = {
      type: 'tool_result',
      call_id: message.tool_call_id,
      output: toolResultContent(message.content),
      ...(toolKind === undefined ? {} : { tool_kind: toolKind }),
    };
    return { role: 'user', items: [result] };
  }
  default:
    throw new TranslatorInputError(`Invalid role '${(message as { role: string }).role}'.`);
  }
};

export const openaiChatCompletionsInputToIR = (payload: OpenAIChatCompletionsPayload): IRInputConversation => {
  const callKinds = openaiChatCompletionsCallKinds(payload);
  return { turns: partitionOpenAIChatCompletionsTurns(payload.messages).map(turn => openaiChatCompletionsTurnToIR(turn, callKinds)) };
};
