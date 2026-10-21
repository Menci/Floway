import type {
  IRInputAssistantContentPart,
  IRInputAssistantItem,
  IRInputConversation,
  IRInputMedia,
  IRInputTextPart,
  IRInputToolResultContentPart,
  IRInputUserItem,
} from '../../../ir/input/types.ts';
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
import { parseJSONWithRawNumbers } from '@floway-dev/protocols/common';

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
  options: AnthropicMessagesFromIROptions,
): Promise<AnthropicMessagesUserContentBlock[]> => {
  const blocks: AnthropicMessagesUserContentBlock[] = [];
  for (const part of item.content) {
    switch (part.type) {
    case 'text': blocks.push({ type: 'text', text: part.text }); break;
    case 'image': {
      if (options.resolveImage === undefined) { blocks.push(imageBlock(part.image)); break; }
      const image = await options.resolveImage(part.image);
      if (image !== null) blocks.push(image);
      break;
    }
    case 'file':
      if (options.allowFileContent !== true) throw new TranslatorInputError('Cannot translate input_file message content to Anthropic Messages.');
      blocks.push(documentBlock(part.file));
      break;
    case 'audio': throw new TranslatorInputError(`Cannot translate Gemini generateContent inlineData MIME type '${part.audio.media_type}' to Anthropic Messages.`);
    case 'refusal': throw new TranslatorInputError("Invalid 'refusal' content part. Only 'text' and 'image_url' are supported in user content.");
    default: throw new TranslatorInputError(`Invalid '${(part as { type: string }).type}' content part.`);
    }
  }
  // Messages' user content is a non-empty block list in the same way.
  return blocks.length === 0 ? [{ type: 'text', text: '' }] : blocks;
};

const toolResultContent = async (
  output: string | readonly IRInputToolResultContentPart[],
  options: AnthropicMessagesFromIROptions,
): Promise<string | AnthropicMessagesToolResultContentBlock[]> => {
  if (typeof output === 'string') return output;
  const blocks: AnthropicMessagesToolResultContentBlock[] = [];
  for (const part of output) {
    if (part.type === 'text') { blocks.push({ type: 'text', text: part.text }); continue; }
    if (part.type === 'file') throw new TranslatorInputError('Cannot translate input_file tool output to Anthropic Messages.');
    if (options.resolveImage !== undefined && part.image.source_kind === 'file') {
      throw new TranslatorInputError('Cannot translate file_id-only image tool output to Anthropic Messages.');
    }
    const image = options.resolveImage === undefined ? imageBlock(part.image) : await options.resolveImage(part.image);
    // Unlike user content, an unresolvable tool-result image is a caller error:
    // the tool returned bytes the target cannot represent.
    if (image === null) throw new TranslatorInputError('Cannot translate unavailable or unsupported image tool output to Anthropic Messages.');
    blocks.push(image);
  }
  // Messages spells an empty tool result as the empty string.
  return blocks.length === 0 ? '' : blocks;
};

const assistantBlocks = (items: readonly IRInputAssistantItem[]): AnthropicMessagesAssistantInputContentBlock[] => {
  const blocks = items.flatMap<AnthropicMessagesAssistantInputContentBlock>(item => {
    switch (item.type) {
    case 'message':
      // An empty content list still represents an explicitly empty assistant
      // message, so it emits one empty text block.
      if (item.content.length === 0) return [{ type: 'text', text: '' }];
      return item.content.map((part): AnthropicMessagesAssistantInputContentBlock => part.type === 'text'
        ? { type: 'text', text: part.text }
        : { type: 'text', text: part.refusal });
    case 'reasoning': {
      // A reasoning item that carries no readable text has nothing to replay on
      // a protocol without opaque reasoning slots.
      const thinking = (item.summary ?? []).join('');
      return thinking === '' ? [] : [{ type: 'thinking', thinking, signature: '' }];
    }
    case 'function_call':
      return [{
        type: 'tool_use' as const,
        id: item.call_id,
        name: item.name,
        // An absent argument object stays absent; Messages omits the `input`
        // key entirely for a tool call that takes no arguments.
        ...(item.arguments === undefined ? {} : { input: parseArguments(item.arguments) }),
      }] as AnthropicMessagesAssistantInputContentBlock[];
    case 'custom_tool_call':
      // Messages has no freeform tool call; the wrapper schema a custom tool is
      // declared with takes one `input` string, so the call is projected onto it.
      return [{ type: 'tool_use', id: item.call_id, name: item.name, input: { input: item.input } }];
    }
  });
  // Messages spells an empty assistant turn as an empty string; a non-empty
  // turn is a block list.
  return blocks;
};

// Messages needs an object, so a call whose arguments are malformed keeps the
// raw text under `raw_arguments` rather than dropping the history.
const parseArguments = (argumentsJson: string): Record<string, unknown> | null => {
  // An out-of-range JSON number such as `1e400` parses to `Infinity` and would
  // serialize back as `null`. Parsing with raw-number preservation keeps the
  // caller's exact token.
  try {
    const parsed = parseJSONWithRawNumbers(argumentsJson);
    if (parsed === null) return null;
    return typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { raw_arguments: argumentsJson };
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
  if (last?.role === 'user') {
    // A string is Messages' spelling of one text block; merging means turning it
    // back into a list and appending.
    if (typeof last.content === 'string') { last.content = [{ type: 'text', text: last.content }, ...blocks]; return; }
    last.content.push(...blocks);
    return;
  }
  // Messages spells a single text block as a bare string.
  messages.push({ role: 'user', content: blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks });
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
export interface AnthropicMessagesFromIROptions {
  /**
   * Messages groups consecutive client items into one message by default, which
   * is what a Chat Completions or Responses source expects. A GenerateContent
   * source treats each `content` as its own message, so its route keeps one
   * message per item instead.
   */
  readonly oneMessagePerItem?: boolean;
  /**
   * Whether a dropped assistant turn keeps the neighbouring user turns apart.
   * A Responses source depends on that boundary; a Chat Completions source
   * merges adjacent user items as its own protocol does.
   */
  readonly separateAfterDroppedAssistant?: boolean;
  /**
   * Whether file content may reach the target. A Responses source rejects it;
   * a GenerateContent source has always mapped an inline PDF to `document`.
   */
  readonly allowFileContent?: boolean;
  readonly resolveImage?: AnthropicMessagesImageResolver;
}

export const anthropicMessagesFromIR = async (
  conversation: IRInputConversation,
  hoistSystem: boolean,
  options: AnthropicMessagesFromIROptions = {},
): Promise<AnthropicMessagesRequestFromIR> => {
  const system: AnthropicMessagesTextBlockParam[] = [];
  let hoisting = hoistSystem;
  const messages: AnthropicMessagesMessage[] = [];
  let separated = false;
  // Messages spells a single text block as a bare string, which is the shape a
  // client sees for a plain user turn.
  const userMessage = (blocks: AnthropicMessagesUserContentBlock[]): AnthropicMessagesMessage => ({
    role: 'user',
    content: blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks,
  });
  const append = (blocks: AnthropicMessagesUserContentBlock[]): void => {
    if (options.oneMessagePerItem === true || separated) {
      separated = false;
      if (blocks.length > 0) messages.push(userMessage(blocks));
      return;
    }
    appendUserBlocks(messages, blocks);
  };
  for (const turn of conversation.turns) {
    if (turn.role === 'assistant') {
      hoisting = false;
      const blocks = assistantBlocks(turn.items);
      // A turn whose every item was dropped contributes no message, but the user
      // turns around it were never adjacent, so a following user item must not
      // merge into the previous message. An explicitly empty text item is not
      // dropped: `assistantBlocks` emitted one empty block for it.
      if (blocks.length === 0) { separated = options.separateAfterDroppedAssistant === true; continue; }
      const content = blocks.length === 1 && blocks[0].type === 'text' && blocks[0].text === '' ? '' : blocks;
      messages.push({ role: 'assistant', content });
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
      append(item.type === 'tool_result'
        ? [{ type: 'tool_result', tool_use_id: item.call_id, content: await toolResultContent(item.output, options), ...(item.is_error === true ? { is_error: true } : {}) }]
        : await userContent(item, options));
    }
  }
  return { system: system.length === 0 ? undefined : system, messages };
};

export type { IRInputAssistantContentPart };
