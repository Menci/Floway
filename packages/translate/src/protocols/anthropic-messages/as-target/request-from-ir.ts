import type {
  IRInputAssistantContentPart,
  IRInputAssistantItem,
  IRInputConversation,
  IRInputMedia,
  IRInputTextPart,
  IRInputToolResultContentPart,
  IRInputUserItem,
} from '../../../ir/input.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type {
  AnthropicMessagesAssistantInputContentBlock,
  AnthropicMessagesImageBlock,
  AnthropicMessagesImageSource,
  AnthropicMessagesMessage,
  AnthropicMessagesTextBlockParam,
  AnthropicMessagesToolResultContentBlock,
  AnthropicMessagesUserContentBlock,
} from '@floway-dev/protocols/anthropic-messages';

const imageSource = (media: IRInputMedia): AnthropicMessagesImageSource => {
  switch (media.source_kind) {
  case 'url': return { type: 'url', url: media.url };
  case 'file': return { type: 'file', file_id: media.file_id };
  case 'base64':
    if (media.media_type === undefined) throw new TranslatorInputError('Anthropic Messages image input requires a media type.');
    return { type: 'base64', media_type: media.media_type as Extract<AnthropicMessagesImageSource, { type: 'base64' }>['media_type'], data: media.data };
  }
};

const imageBlock = (media: IRInputMedia): AnthropicMessagesImageBlock => ({ type: 'image', source: imageSource(media) });

const documentBlock = (media: IRInputMedia): AnthropicMessagesUserContentBlock => {
  switch (media.source_kind) {
  case 'url': return { type: 'document', source: { type: 'url', url: media.url } };
  case 'file': return { type: 'document', source: { type: 'file', file_id: media.file_id } };
  case 'base64': {
    if (media.media_type === undefined) throw new TranslatorInputError('Anthropic Messages document input requires a media type.');
    return media.media_type === 'text/plain'
      ? { type: 'document', source: { type: 'text', media_type: 'text/plain', data: media.data } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: media.data } };
  }
  }
};

const systemContent = (content: readonly IRInputTextPart[]): AnthropicMessagesTextBlockParam[] => content.map(part => ({ type: 'text', text: part.text }));

const userContent = (item: Extract<IRInputUserItem, { type: 'message' }>): AnthropicMessagesUserContentBlock[] => item.content.map(part => {
  switch (part.type) {
  case 'text': return { type: 'text', text: part.text };
  case 'image': return imageBlock(part.image);
  case 'file': return documentBlock(part.file);
  case 'audio': throw new TranslatorInputError('Cannot translate input audio to Anthropic Messages.');
  case 'refusal': throw new TranslatorInputError('Cannot translate refusal content in a user message to Anthropic Messages.');
  }
});

const toolResultContent = (output: string | readonly IRInputToolResultContentPart[]): string | AnthropicMessagesToolResultContentBlock[] => typeof output === 'string'
  ? output
  : [...output].map((part): AnthropicMessagesToolResultContentBlock => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'image') return imageBlock(part.image);
    throw new TranslatorInputError('Cannot translate file content in a tool result to Anthropic Messages.');
  });

const assistantBlocks = (items: readonly IRInputAssistantItem[]): AnthropicMessagesAssistantInputContentBlock[] => {
  const blocks = items.flatMap<AnthropicMessagesAssistantInputContentBlock>(item => {
    switch (item.type) {
    case 'message':
      return item.content.map((part): AnthropicMessagesAssistantInputContentBlock => part.type === 'text'
        ? { type: 'text', text: part.text }
        : { type: 'text', text: part.refusal });
    case 'reasoning':
      return [{ type: 'thinking', thinking: (item.summary ?? []).join(''), signature: '' }];
    case 'function_call':
      return [{ type: 'tool_use', id: item.call_id, name: item.name, input: parseArguments(item.arguments) }];
    case 'custom_tool_call':
      throw new TranslatorInputError('Cannot translate a custom tool call to Anthropic Messages.');
    }
  });
  return blocks;
};

// Messages needs an object, so a call whose arguments are malformed keeps the
// raw text under `raw_arguments` rather than dropping the history.
const parseArguments = (argumentsJson: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { raw_arguments: argumentsJson };
  } catch {
    return { raw_arguments: argumentsJson };
  }
};

// Messages keeps tool results inside a user message, so consecutive IR tool
// results collapse into one message and interleaved user content stays ordered
// inside it.
const appendUserBlocks = (messages: AnthropicMessagesMessage[], blocks: AnthropicMessagesUserContentBlock[]): void => {
  if (blocks.length === 0) return;
  const last = messages.at(-1);
  if (last?.role === 'user' && Array.isArray(last.content)) {
    last.content.push(...blocks);
    return;
  }
  messages.push({ role: 'user', content: blocks });
};

export const anthropicMessagesFromIR = (conversation: IRInputConversation): AnthropicMessagesMessage[] => {
  const messages: AnthropicMessagesMessage[] = [];
  for (const turn of conversation.turns) {
    if (turn.role === 'assistant') {
      messages.push({ role: 'assistant', content: assistantBlocks(turn.items) });
      continue;
    }
    for (const item of turn.items) {
      if (item.type === 'message' && item.role !== 'user') {
        messages.push({ role: 'system', content: systemContent(item.content) });
        continue;
      }
      appendUserBlocks(messages, item.type === 'tool_result'
        ? [{ type: 'tool_result', tool_use_id: item.call_id, content: toolResultContent(item.output), ...(item.is_error === true ? { is_error: true } : {}) }]
        : userContent(item));
    }
  }
  return messages;
};

export type { IRInputAssistantContentPart };
