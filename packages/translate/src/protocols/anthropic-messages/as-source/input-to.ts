import { partitionAnthropicMessagesTurns, type AnthropicMessagesConversationTurn } from './conversation-turns.ts';
import type {
  IRInputAssistantContentPart,
  IRInputAssistantItem,
  IRInputConversation,
  IRInputMedia,
  IRInputTextPart,
  IRInputToolResultContentPart,
  IRInputTurn,
  IRInputUserContentPart,
  IRInputUserItem,
} from '../../../ir/input/types.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type {

  AnthropicMessagesImageBlock,
  AnthropicMessagesMessage,
  AnthropicMessagesPayload,
  AnthropicMessagesTextBlockParam,
  AnthropicMessagesToolResultBlock,
  AnthropicMessagesUserContentBlock,
} from '@floway-dev/protocols/anthropic-messages';

const DATA_URL = /^data:([^;,]+)?;base64,(.*)$/s;

const mediaFromUrl = (url: string): IRInputMedia => {
  const dataUrl = DATA_URL.exec(url);
  if (dataUrl === null) return { source_kind: 'url', url };
  const mediaType = dataUrl[1]?.trim();
  return { source_kind: 'base64', ...(mediaType === undefined || mediaType === '' ? {} : { media_type: mediaType }), data: dataUrl[2] };
};

const imageMedia = (source: AnthropicMessagesImageBlock['source']): IRInputMedia => {
  switch (source.type) {
  case 'base64': return { source_kind: 'base64', media_type: source.media_type, data: source.data };
  case 'url': return mediaFromUrl(source.url);
  case 'file': return { source_kind: 'file', file_id: source.file_id };
  }
};

const textBlocks = (content: string | readonly AnthropicMessagesTextBlockParam[]): IRInputTextPart[] => typeof content === 'string'
  ? content === '' ? [] : [{ type: 'text', text: content }]
  : content.map(block => {
      if (block.type !== 'text') throw new TranslatorInputError('Only text system content is supported.');
      return { type: 'text', text: block.text };
    });

// Messages carries file content as a `document` block whose source is a PDF,
// plain text, a URL, or an embedded content array. The output IR keeps the same two
// payload kinds it uses everywhere else.
const documentMedia = (block: Extract<AnthropicMessagesUserContentBlock, { type: 'document' }>): IRInputMedia => {
  const source = block.source;
  switch (source.type) {
  case 'base64': return { source_kind: 'base64', media_type: source.media_type, data: source.data };
  case 'url': return { source_kind: 'url', url: source.url };
  case 'file': return { source_kind: 'file', file_id: source.file_id };
  case 'text': return { source_kind: 'base64', media_type: source.media_type, data: source.data };
  case 'content':
    throw new TranslatorInputError('Cannot translate an inline content document; supply a base64, URL, text, or file source.');
  }
};

interface MessagePosition {
  readonly messageIdx: number;
  readonly blockIdx: number;
  // Each pair spells an unsupported user block differently; the reader supplies
  // the neutral suffix and the caller's line stays stable.
  readonly unsupportedSuffix?: string;
}

const userContentPart = (
  block: Exclude<AnthropicMessagesUserContentBlock, AnthropicMessagesToolResultBlock>,
  at: MessagePosition,
): IRInputUserContentPart => {
  switch (block.type) {
  case 'text': return { type: 'text', text: block.text };
  case 'image': return { type: 'image', image: imageMedia(block.source) };
  case 'document': return { type: 'file', file: documentMedia(block) };
  default: throw new TranslatorInputError(`messages.${at.messageIdx}.content.${at.blockIdx}.type: '${(block as { type: string }).type}'${at.unsupportedSuffix ?? ' content blocks are not supported on this model'}`);
  }
};

const toolResultPart = (block: AnthropicMessagesToolResultBlock['content'] extends string | undefined ? never : AnthropicMessagesToolResultBlock['content']): IRInputToolResultContentPart[] => block === undefined
  ? []
  : typeof block === 'string'
    ? [{ type: 'text', text: block }]
    : block.flatMap((part): IRInputToolResultContentPart[] => {
        if (part.type === 'text') return [{ type: 'text', text: part.text }];
        if (part.type === 'image') return [{ type: 'image', image: imageMedia(part.source) }];
        if (part.type === 'search_result') return [{ type: 'text', text: JSON.stringify([part]) }];
        throw new TranslatorInputError(`'${(part as { type: string }).type}' tool result content blocks are not supported.`);
      });

const userItems = (
  message: Exclude<AnthropicMessagesMessage, { role: 'assistant' }>,
  messageIdx: number,
  unsupportedSuffix?: string,
): IRInputUserItem[] => {
  if (message.role === 'system') {
    if (typeof message.content !== 'string' && message.content.some(block => block.type !== 'text')) {
      throw new TranslatorInputError('Only text system content is supported.');
    }
    return [{ type: 'message', role: 'system', content: textBlocks(message.content as string | readonly AnthropicMessagesTextBlockParam[]) }];
  }
  if (typeof message.content === 'string') {
    return [{ type: 'message', role: 'user', content: message.content === '' ? [] : [{ type: 'text', text: message.content }] }];
  }

  const items: IRInputUserItem[] = [];
  const pending: IRInputUserContentPart[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    items.push({ type: 'message', role: 'user', content: [...pending] });
    pending.length = 0;
  };

  // Messages keeps tool results inline with user content. Flat output IR items keep
  // the chronology and let each target regroup.
  for (const [blockIdx, block] of message.content.entries()) {
    if (block.type === 'tool_result') {
      flush();
      const output = toolResultPart(block.content);
      items.push({
        type: 'tool_result',
        call_id: block.tool_use_id,
        output: output.length === 0 ? '' : output.length === 1 && output[0].type === 'text' ? output[0].text : output,
        ...(block.is_error === true ? { is_error: true } : {}),
      });
      continue;
    }
    pending.push(userContentPart(block, { messageIdx, blockIdx, unsupportedSuffix }));
  }
  flush();
  return items;
};

interface AnthropicMessagesAssistantSegments {
  readonly assistant: IRInputAssistantItem[];
  // A hosted search result is the model's own tool output rather than a client
  // turn, so it cannot occupy an assistant item. It is downgraded to a plain
  // tool result in a following user turn, which is the only shape every target
  // can express.
  readonly downgraded: IRInputUserItem[];
}

const assistantSegments = (message: Extract<AnthropicMessagesMessage, { role: 'assistant' }>, messageIdx: number): AnthropicMessagesAssistantSegments => {
  if (typeof message.content === 'string') {
    return { assistant: message.content === '' ? [] : [{ type: 'message', content: [{ type: 'text', text: message.content }] }], downgraded: [] };
  }

  const items: IRInputAssistantItem[] = [];
  const downgraded: IRInputUserItem[] = [];
  const pending: IRInputAssistantContentPart[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    items.push({ type: 'message', content: [...pending] });
    pending.length = 0;
  };

  for (const [blockIdx, block] of message.content.entries()) {
    switch (block.type) {
    case 'text':
      pending.push({ type: 'text', text: block.text });
      break;
    case 'thinking':
      flush();
      if (block.thinking !== '') items.push({ type: 'reasoning', summary: [block.thinking] });
      break;
    case 'redacted_thinking':
      // The redacted payload is an opaque, vendor-signed blob; the sidecar is
      // the only place that can carry it back to the same vendor.
      break;
    case 'tool_use':
      flush();
      items.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
      break;
    case 'server_tool_use':
      flush();
      items.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
      break;
    // A hosted search result is server-tool history: no pair translates it, and
    // the gateway's search shim owns its replay.
    case 'web_search_tool_result':
      flush();
      downgraded.push({
        type: 'tool_result',
        call_id: block.tool_use_id,
        output: JSON.stringify(block.content),
        ...(Array.isArray(block.content) ? {} : { is_error: true }),
      });
      break;
    // Hosted results with no plain-tool spelling stay outside the output IR entirely;
    // their owning shim restores them before or after translation.
    case 'web_fetch_tool_result':
    case 'code_execution_tool_result':
    case 'bash_code_execution_tool_result':
    case 'text_editor_code_execution_tool_result':
    case 'tool_search_tool_result':
      flush();
      break;
    default:
      throw new TranslatorInputError(`messages.${messageIdx}.content.${blockIdx}.type: '${(block as { type: string }).type}' assistant content blocks are not supported on this model`);
    }
  }
  flush();
  return { assistant: items, downgraded };
};

export const anthropicMessagesSystemToIR = (system: AnthropicMessagesPayload['system']): IRInputTurn | undefined => {
  if (system === undefined) return undefined;
  const content = textBlocks(system);
  return content.length === 0 ? undefined : { role: 'user', items: [{ type: 'message', role: 'system', content }] };
};

/** Whether a turn carries reasoning only the sidecar can restore. */
export const anthropicMessagesDropsReasoning = (turn: AnthropicMessagesConversationTurn): boolean => turn.role === 'assistant'
  && turn.items.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'redacted_thinking'));

export const anthropicMessagesTurnToIR = (
  turn: AnthropicMessagesConversationTurn,
  firstMessageIndex = 0,
  unsupportedSuffix?: string,
): IRInputTurn[] => {
  if (turn.role === 'assistant') {
    const turns: IRInputTurn[] = [];
    for (const [index, message] of turn.items.entries()) {
      const segments = assistantSegments(message, firstMessageIndex + index);
      if (segments.assistant.length > 0) turns.push({ role: 'assistant', items: segments.assistant });
      if (segments.downgraded.length > 0) turns.push({ role: 'user', items: segments.downgraded });
    }
    return turns;
  }
  return [{
    role: 'user',
    items: turn.items.flatMap((message, index) => {
      if (message.role !== 'user' && message.role !== 'system') {
        throw new TranslatorInputError(`messages.${firstMessageIndex + index}.role: role '${(message as { role: string }).role}' is not supported on this model`);
      }
      return userItems(message, firstMessageIndex + index, unsupportedSuffix);
    }),
  }];
};

export const anthropicMessagesInputToIR = (payload: AnthropicMessagesPayload): IRInputConversation => {
  const turns: IRInputTurn[] = [];
  // Messages' top-level system is the same concept as a leading system item.
  const system = anthropicMessagesSystemToIR(payload.system);
  if (system !== undefined) turns.push(system);

  let messageIndex = 0;
  for (const turn of partitionAnthropicMessagesTurns(payload.messages)) {
    turns.push(...anthropicMessagesTurnToIR(turn, messageIndex));
    messageIndex += turn.items.length;
  }
  return { turns };
};
