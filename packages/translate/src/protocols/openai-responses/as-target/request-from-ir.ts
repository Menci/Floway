import type {
  IRInputAssistantItem,
  IRInputConversation,
  IRInputMedia,
  IRInputToolResultContentPart,
  IRInputUserItem,
} from '../../../ir/input.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type {
  CanonicalOpenAIResponsesInputItem,
  OpenAIResponsesInputContent,
  OpenAIResponsesToolOutputContent,
} from '@floway-dev/protocols/openai-responses';

const inputContent = (media: IRInputMedia, detail?: string | null): OpenAIResponsesInputContent => {
  switch (media.source_kind) {
  case 'url':
    return { type: 'input_image', image_url: media.url, ...(detail == null ? {} : { detail }) };
  case 'file':
    return { type: 'input_image', file_id: media.file_id, ...(detail == null ? {} : { detail }) };
  case 'base64':
    return { type: 'input_image', image_url: `data:${media.media_type ?? 'application/octet-stream'};base64,${media.data}`, ...(detail == null ? {} : { detail }) };
  }
};

const fileContent = (media: IRInputMedia, filename?: string | null): OpenAIResponsesInputContent => {
  const name = filename == null ? {} : { filename };
  switch (media.source_kind) {
  case 'url':
    return { type: 'input_file', file_url: media.url, ...name };
  case 'file':
    return { type: 'input_file', file_id: media.file_id, ...name };
  case 'base64':
    return { type: 'input_file', file_data: media.data, ...name };
  }
};

// Responses tool output admits text, images, and files, but not refusals, so it
// is projected from the tool-result parts rather than the message-part union.
const toolResultOutput = (output: string | readonly IRInputToolResultContentPart[]): string | OpenAIResponsesToolOutputContent[] => typeof output === 'string'
  ? output
  : [...output].map(part => {
    if (part.type === 'text') return { type: 'input_text' as const, text: part.text };
    if (part.type === 'image') return inputContent(part.image, part.detail) as OpenAIResponsesToolOutputContent;
    return fileContent(part.file, part.filename) as OpenAIResponsesToolOutputContent;
  });

const userContent = (item: Extract<IRInputUserItem, { type: 'message' }>): OpenAIResponsesInputContent[] | string => {
  // Responses keeps the compact string spelling only when the message is pure
  // text; mixed content becomes parts so media and boundaries survive.
  if (item.content.every(part => part.type === 'text')) return item.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
  return item.content.map(part => {
    switch (part.type) {
    case 'text': return { type: 'input_text' as const, text: part.text };
    case 'refusal': throw new TranslatorInputError('Cannot translate refusal content in a user message.');
    case 'image': return inputContent(part.image, part.detail);
    case 'file': return fileContent(part.file, part.filename);
    case 'audio': throw new TranslatorInputError('Cannot translate input audio to OpenAI Responses.');
    }
  });
};

const assistantItems = (items: readonly IRInputAssistantItem[]): CanonicalOpenAIResponsesInputItem[] => items.map(item => {
  switch (item.type) {
  case 'message':
    return {
      type: 'message',
      role: 'assistant',
      content: item.content.map(part => part.type === 'text'
        ? { type: 'output_text' as const, text: part.text }
        : { type: 'refusal' as const, refusal: part.refusal }),
    };
  case 'reasoning':
    return {
      type: 'reasoning',
      summary: (item.summary ?? []).map(text => ({ type: 'summary_text' as const, text })),
      ...(item.content === undefined ? {} : { content: item.content.map(text => ({ type: 'reasoning_text' as const, text })) }),
    };
  case 'function_call':
    return { type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments, status: 'completed' };
  case 'custom_tool_call':
    return { type: 'custom_tool_call', call_id: item.call_id, name: item.name, input: item.input, status: 'completed' };
  }
});

const userItems = (items: readonly IRInputUserItem[]): CanonicalOpenAIResponsesInputItem[] => items.map(item => {
  switch (item.type) {
  case 'message': {
    if (item.role === 'user') return { type: 'message', role: 'user', content: userContent(item) };
    // Responses accepts a bare string for a text-only message. A single text
    // part collapses to it so the common case stays on the compact spelling;
    // several parts keep the array so their boundaries survive.
    const content = item.content.length === 1
      ? item.content[0].text
      : item.content.map(part => ({ type: 'input_text' as const, text: part.text }));
    return { type: 'message', role: item.role, content };
  }
  case 'tool_result': {
    const output = toolResultOutput(item.output);
    return item.tool_kind === 'custom'
      ? { type: 'custom_tool_call_output', call_id: item.call_id, output }
      : { type: 'function_call_output', call_id: item.call_id, output, ...(item.is_error === true ? { status: 'incomplete' as const } : {}) };
  }
  }
});

export interface OpenAIResponsesRequestFromIR {
  readonly instructions: string | undefined;
  readonly input: CanonicalOpenAIResponsesInputItem[];
}

/**
 * `hoistSystem` lifts the leading system/developer run into the Responses
 * `instructions` slot. Only the first segment of a conversation may do so.
 *
 * Responses spells the slot as one string, so a multi-block run is joined with
 * blank lines. A multi-message run collapses the same way.
 */
export const openaiResponsesFromIR = (conversation: IRInputConversation, hoistSystem: boolean): OpenAIResponsesRequestFromIR => {
  const instructions: string[] = [];
  let hoisting = hoistSystem;

  const input = conversation.turns.flatMap(item => {
    if (item.role === 'assistant') {
      hoisting = false;
      return assistantItems(item.items);
    }
    return item.items.flatMap((entry): CanonicalOpenAIResponsesInputItem[] => {
      if (hoisting && entry.type === 'message' && entry.role !== 'user') {
        const text = entry.content.map(part => part.text).join('');
        if (text !== '') instructions.push(text);
        return [];
      }
      hoisting = false;
      return userItems([entry]);
    });
  });

  return { instructions: instructions.length === 0 ? undefined : instructions.join('\n\n'), input };
};
