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
import { warnDroppedUnrecognizedAssistantReasoning } from '../../../round-trip/resolve.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import { canonicalizeOpenAIResponsesPayload } from '../canonicalize-payload.ts';
import { partitionOpenAIResponsesTurns } from './conversation-turns.ts';
import { flattenNamespaceTools, type NamespaceToolNames } from './namespace-tools.ts';
import { rejectProgramCaller, rejectProgrammaticOpenAIResponsesPayload } from './programmatic-tooling.ts';
import { isOpenAIResponsesEncryptedReasoning } from './round-trip.ts';
import type {
  CanonicalOpenAIResponsesInputItem,
  OpenAIResponsesInputContent,
  OpenAIResponsesInputMessageEx,
  OpenAIResponsesRequestPayloadEx,
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
  if (typeof part.file_data === 'string') return { source_kind: 'base64', data: part.file_data };
  throw new TranslatorInputError('An OpenAI Responses input_file requires file_id, file_url, or file_data.');
};

const userContentPart = (part: OpenAIResponsesInputContent): IRInputUserContentPart => {
  switch (part.type) {
  case 'input_text':
  case 'output_text':
    return { type: 'text', text: part.text };
  case 'refusal':
    return { type: 'refusal', refusal: part.refusal };
  case 'input_image': {
    const image = imageMedia(part);
    return { type: 'image', image, ...(part.detail == null ? {} : { detail: part.detail }) };
  }
  case 'input_file':
    return { type: 'file', file: fileMedia(part), ...(typeof part.filename === 'string' ? { filename: part.filename } : {}) };
  }
};

const userContent = (content: OpenAIResponsesInputMessageEx['content']): IRInputUserContentPart[] => typeof content === 'string'
  ? content === '' ? [] : [{ type: 'text', text: content }]
  : content.map(userContentPart);

const systemContent = (message: OpenAIResponsesInputMessageEx): IRInputTextPart[] => typeof message.content === 'string'
  ? message.content === '' ? [] : [{ type: 'text', text: message.content }]
  : message.content.map(part => {
    if (part.type !== 'input_text' && part.type !== 'output_text') {
      throw new TranslatorInputError(`Invalid content block type '${part.type}' in ${message.role} message.`);
    }
    return { type: 'text', text: part.text };
  });

const assistantContent = (message: OpenAIResponsesInputMessageEx): IRInputAssistantContentPart[] => typeof message.content === 'string'
  ? message.content === '' ? [] : [{ type: 'text', text: message.content }]
  : message.content.map(part => {
    if (part.type === 'input_text' || part.type === 'output_text') return { type: 'text' as const, text: part.text };
    if (part.type === 'refusal') return { type: 'refusal' as const, refusal: part.refusal };
    throw new TranslatorInputError(`Cannot translate ${part.type} assistant content.`);
  });

const toolResultContent = (output: string | readonly OpenAIResponsesInputContent[]): string | readonly IRInputToolResultContentPart[] => typeof output === 'string'
  ? output
  : output.map(part => {
    if (part.type === 'input_image') return { type: 'image' as const, image: imageMedia(part), ...(part.detail == null ? {} : { detail: part.detail }) };
    if (part.type === 'input_file') return { type: 'file' as const, file: fileMedia(part), ...(typeof part.filename === 'string' ? { filename: part.filename } : {}) };
    if (part.type === 'refusal') throw new TranslatorInputError('Cannot translate refusal content in a tool output.');
    return { type: 'text' as const, text: part.text };
  });

const assistantItems = (items: readonly CanonicalOpenAIResponsesInputItem[]): IRInputAssistantItem[] => items.map(item => {
  rejectProgramCaller(item);
  switch (item.type) {
  case 'message':
    if (item.role !== 'assistant') throw new TranslatorInputError(`Invalid assistant message role '${item.role}'.`);
    return { type: 'message' as const, content: assistantContent(item) };
  case 'reasoning':
    // An encrypted carrier is the sidecar's material: it is authenticated
    // against the issuing deployment and means nothing to another vendor.
    if (isOpenAIResponsesEncryptedReasoning(item)) {
      warnDroppedUnrecognizedAssistantReasoning('openaiResponses', 'openaiChatCompletions');
      return { type: 'reasoning' as const, summary: [] };
    }
    return {
      type: 'reasoning' as const,
      ...(item.summary.length > 0 ? { summary: item.summary.map(part => part.text) } : {}),
      ...(item.content === undefined || item.content.length === 0 ? {} : { content: item.content.map(part => part.text) }),
    };
  case 'function_call':
    return { type: 'function_call' as const, call_id: item.call_id, name: item.name, arguments: item.arguments };
  case 'custom_tool_call':
    return { type: 'custom_tool_call' as const, call_id: item.call_id, name: item.name, input: item.input };
  default:
    throw new TranslatorInputError(`Invalid input item type '${(item as { type: string }).type}'.`);
  }
}).filter(item => item.type !== 'reasoning' || (item.summary?.length ?? 0) > 0 || (item.content?.length ?? 0) > 0);

const userItems = (items: readonly CanonicalOpenAIResponsesInputItem[]): IRInputUserItem[] => items.map(item => {
  rejectProgramCaller(item);
  switch (item.type) {
  case 'message':
    switch (item.role) {
    case 'user': return { type: 'message' as const, role: 'user' as const, content: userContent(item.content) };
    case 'system':
    case 'developer': return { type: 'message' as const, role: item.role, content: systemContent(item) };
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
    return result;
  }
  case 'custom_tool_call_output':
    return {
      type: 'tool_result' as const,
      call_id: item.call_id,
      output: toolResultContent(item.output),
      tool_kind: 'custom' as const,
    };
  default:
    throw new TranslatorInputError(`Invalid input item type '${(item as { type: string }).type}'.`);
  }
});

export interface OpenAIResponsesInputIR {
  readonly conversation: IRInputConversation;
  readonly namespaceToolNames: NamespaceToolNames;
}

export const openaiResponsesTurnToIR = (
  turn: { readonly role: 'assistant' | 'bare'; readonly items: readonly CanonicalOpenAIResponsesInputItem[] },
  flattenInput: (input: readonly CanonicalOpenAIResponsesInputItem[]) => CanonicalOpenAIResponsesInputItem[],
  _callerFacts?: unknown,
): IRInputTurn => {
  const items = flattenInput(turn.items);
  return turn.role === 'assistant'
    ? { role: 'assistant', items: assistantItems(items) }
    : { role: 'user', items: userItems(items) };
};

export type { OpenAIResponsesCallerFacts } from './request-to-ir-types.ts';

export const openaiResponsesInputToIR = (source: OpenAIResponsesRequestPayloadEx): OpenAIResponsesInputIR => {
  const canonical = canonicalizeOpenAIResponsesPayload(source);
  const { payload, names, flattenInput } = flattenNamespaceTools(canonical);
  rejectProgrammaticOpenAIResponsesPayload(payload, 'translation');

  const turns: IRInputTurn[] = [];
  // Leading system/developer inputs are the same concept as `instructions`
  // and GenerateContent `systemInstruction`, so they join one leading run.
  if (payload.instructions) {
    turns.push({ role: 'user', items: [{ type: 'message', role: 'system', content: [{ type: 'text', text: payload.instructions }] }] });
  }
  for (const turn of partitionOpenAIResponsesTurns(canonical.input)) {
    const items = flattenInput(turn.items);
    if (items.length === 0) continue;
    turns.push(turn.role === 'assistant'
      ? { role: 'assistant', items: assistantItems(items) }
      : { role: 'user', items: userItems(items) });
  }
  return { conversation: { turns }, namespaceToolNames: names };
};
