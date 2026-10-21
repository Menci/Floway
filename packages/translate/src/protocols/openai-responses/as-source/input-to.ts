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
} from '../../../ir/input/types.ts';
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
        throw new TranslatorInputError(`Invalid '${part.type}' content part in ${message.role} message. Only 'input_text' content parts are supported in ${message.role} messages on this model.`);
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

const assistantItems = (items: readonly CanonicalOpenAIResponsesInputItem[], unknownItem: (item: CanonicalOpenAIResponsesInputItem) => never): IRInputAssistantItem[] => items.map((item): IRInputAssistantItem | undefined => {
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
    throw new TranslatorInputError(`Invalid input item type '${item.type}'.`);
  default:
    unknownItem(item);
  }
}).filter((item): item is IRInputAssistantItem => item !== undefined);

const userItems = (items: readonly CanonicalOpenAIResponsesInputItem[], unknownItem: (item: CanonicalOpenAIResponsesInputItem) => never): IRInputUserItem[] => items.map(item => {
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
    unknownItem(item);
  }
});

export interface OpenAIResponsesInputIR {
  readonly conversation: IRInputConversation;
  readonly namespaceToolNames: NamespaceToolNames;
}

/** Whether a turn carries an encrypted reasoning carrier the output IR cannot hold. */
export const openaiResponsesDropsReasoning = (turn: { readonly role: 'assistant' | 'bare'; readonly items: readonly CanonicalOpenAIResponsesInputItem[] }): boolean =>
  turn.items.some(item => item.type === 'reasoning' && isOpenAIResponsesEncryptedReasoning(item));

/** The top-level `instructions` field as its own leading system item. */
export const openaiResponsesInstructionsToIR = (instructions: string | null | undefined): IRInputTurn | undefined => instructions
  ? { role: 'user', items: [{ type: 'message', role: 'system', content: [{ type: 'text', text: instructions }] }] }
  : undefined;

export const openaiResponsesTurnToIR = (
  turn: { readonly role: 'assistant' | 'bare'; readonly items: readonly CanonicalOpenAIResponsesInputItem[] },
  flattenInput: (input: readonly CanonicalOpenAIResponsesInputItem[]) => CanonicalOpenAIResponsesInputItem[],
  unknownItem: (item: CanonicalOpenAIResponsesInputItem) => never = item => {
    throw new TranslatorInputError(`Invalid input item: ${JSON.stringify(item)}`);
  },
): IRInputTurn[] => {
  const items = flattenInput(turn.items);
  if (turn.role !== 'assistant') return [{ role: 'user', items: userItems(items, unknownItem) }];
  // Every assistant item was dropped (an opaque reasoning carrier, say). The
  // turn carried a boundary that must survive, so writers still see it as a
  // separator but emit no message for it.
  return [{ role: 'assistant', items: assistantItems(items, unknownItem) }];
};

export const openaiResponsesInputToIR = (source: OpenAIResponsesRequestPayloadEx): OpenAIResponsesInputIR => {
  const canonical = canonicalizeOpenAIResponsesPayload(source);
  const { payload, names, flattenInput } = flattenNamespaceTools(canonical);
  rejectProgrammaticOpenAIResponsesPayload(payload, 'translation');

  const turns: IRInputTurn[] = [];
  const reject = (item: CanonicalOpenAIResponsesInputItem): never => {
    throw new TranslatorInputError(`Invalid input item: ${JSON.stringify(item)}`);
  };
  if (payload.instructions) {
    turns.push({ role: 'user', items: [{ type: 'message', role: 'system', content: [{ type: 'text', text: payload.instructions }] }] });
  }
  for (const turn of partitionOpenAIResponsesTurns(canonical.input)) {
    const items = flattenInput(turn.items);
    if (items.length === 0) continue;
    turns.push(turn.role === 'assistant'
      ? { role: 'assistant', items: assistantItems(items, reject) }
      : { role: 'user', items: userItems(items, reject) });
  }
  return { conversation: { turns }, namespaceToolNames: names };
};
