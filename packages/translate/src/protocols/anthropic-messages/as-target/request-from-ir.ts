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

/**
 * Messages accepts only base64, URL, or file IDs for an image source, but a
 * remote URL must sometimes be inlined because an upstream rejects fetching it.
 * The loader is target-owned, exactly like the output path's remote-image
 * adapter, so it stays out of the IR value.
 *
 * A URL the loader cannot resolve is dropped instead of failing the request:
 * the prompt remains usable and the caller sees no image rather than an error.
 */
export type AnthropicMessagesImageResolver = (media: IRInputMedia) => Promise<AnthropicMessagesImageBlock | null>;

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

const userContent = async (
  item: Extract<IRInputUserItem, { type: 'message' }>,
  resolveImage: AnthropicMessagesImageResolver | undefined,
): Promise<AnthropicMessagesUserContentBlock[]> => {
  const blocks: AnthropicMessagesUserContentBlock[] = [];
  for (const part of item.content) {
    switch (part.type) {
    case 'text': blocks.push({ type: 'text', text: part.text }); break;
    case 'image': {
      if (resolveImage === undefined) { blocks.push(imageBlock(part.image)); break; }
      const image = await resolveImage(part.image);
      if (image !== null) blocks.push(image);
      break;
    }
    case 'file': blocks.push(documentBlock(part.file)); break;
    case 'audio': throw new TranslatorInputError('Cannot translate input audio to Anthropic Messages.');
    case 'refusal': throw new TranslatorInputError('Cannot translate refusal content in a user message to Anthropic Messages.');
    default: throw new TranslatorInputError(`Invalid '${(part as { type: string }).type}' content part.`);
    }
  }
  // Messages' user content is a non-empty block list in the same way.
  return blocks.length === 0 ? [{ type: 'text', text: '' }] : blocks;
};

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
  // Messages' assistant content is a non-empty block list; an empty assistant
  // turn is spelled as one empty text block.
  return blocks.length === 0 ? [{ type: 'text', text: '' }] : blocks;
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

export interface AnthropicMessagesRequestFromIR {
  readonly system: AnthropicMessagesTextBlockParam[] | undefined;
  readonly messages: AnthropicMessagesMessage[];
}

/**
 * Messages keeps the system prompt in its own top-level field. `hoistSystem`
 * lifts the leading system run there, one block per source text part so the
 * boundaries survive; later system messages stay inline at their position.
 */
export const anthropicMessagesFromIR = async (
  conversation: IRInputConversation,
  hoistSystem: boolean,
  resolveImage?: AnthropicMessagesImageResolver,
): Promise<AnthropicMessagesRequestFromIR> => {
  const system: AnthropicMessagesTextBlockParam[] = [];
  let hoisting = hoistSystem;
  const messages: AnthropicMessagesMessage[] = [];
  for (const turn of conversation.turns) {
    if (turn.role === 'assistant') {
      hoisting = false;
      messages.push({ role: 'assistant', content: assistantBlocks(turn.items) });
      continue;
    }
    for (const item of turn.items) {
      if (item.type === 'message' && item.role !== 'user') {
        // Messages system content is text-only, so an image there is a caller
        // error rather than something to drop.
        if (item.content.some(part => part.type !== 'text')) {
          throw new TranslatorInputError(`Invalid '${(item.content.find(part => part.type !== 'text') as { type: string }).type}' content part in ${item.role} message. Only 'text' content parts are supported in ${item.role} messages on this model.`);
        }
        if (hoisting) {
          system.push(...systemContent(item.content));
          continue;
        }
        messages.push({ role: 'system', content: systemContent(item.content) });
        continue;
      }
      hoisting = false;
      appendUserBlocks(messages, item.type === 'tool_result'
        ? [{ type: 'tool_result', tool_use_id: item.call_id, content: toolResultContent(item.output), ...(item.is_error === true ? { is_error: true } : {}) }]
        : await userContent(item, resolveImage));
    }
  }
  return { system: system.length === 0 ? undefined : system, messages };
};

export type { IRInputAssistantContentPart };
