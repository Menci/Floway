import type {
  IRInputAssistantItem,
  IRInputConversation,
  IRInputMedia,
  IRInputToolResultContentPart,
  IRInputUserItem,
} from '../../../ir/input/types.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type {
  OpenAIChatCompletionsContentPart,
  OpenAIChatCompletionsMessage,
  OpenAIChatCompletionsToolCall,
  OpenAIChatCompletionsUserContentPart,
} from '@floway-dev/protocols/openai-chat-completions';

// Chat Completions names a container while the IR keeps MIME types.
const audioFormat = (mediaType: string): string => {
  if (mediaType === 'audio/wav') return 'wav';
  if (mediaType === 'audio/mpeg' || mediaType === 'audio/mp3') return 'mp3';
  throw new TranslatorInputError(`Cannot translate audio MIME type '${mediaType}' to OpenAI Chat Completions.`);
};

const dataUrl = (media: Extract<IRInputMedia, { source_kind: 'base64' }>): string => `data:${media.media_type ?? 'application/octet-stream'};base64,${media.data}`;

const imageUrlPart = (media: IRInputMedia, detail?: string | null): OpenAIChatCompletionsUserContentPart => ({
  type: 'image_url',
  image_url: {
    url: media.source_kind === 'url' ? media.url : media.source_kind === 'base64' ? dataUrl(media) : (() => { throw new TranslatorInputError('Cannot translate file_id-only image content to OpenAI Chat Completions.'); })(),
    ...(detail == null ? {} : { detail }),
  },
});

const filePart = (media: IRInputMedia, filename?: string | null): OpenAIChatCompletionsUserContentPart => {
  const name = filename == null ? {} : { filename };
  switch (media.source_kind) {
  case 'file': return { type: 'file', file: { file_id: media.file_id, ...name } };
  case 'base64': return { type: 'file', file: { file_data: dataUrl(media), ...name } };
  case 'url': throw new TranslatorInputError('Cannot translate a file URL to OpenAI Chat Completions.');
  }
};

const userContent = (item: Extract<IRInputUserItem, { type: 'message' }>): string | OpenAIChatCompletionsUserContentPart[] => {
  if (item.content.every(part => part.type === 'text')) return item.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n\n');
  const parts = item.content.flatMap<OpenAIChatCompletionsContentPart>(part => {
    switch (part.type) {
    case 'text': return [{ type: 'text', text: part.text }];
    case 'refusal': return [{ type: 'refusal', refusal: part.refusal }];
    case 'image': return [imageUrlPart(part.image, part.detail)];
    case 'file': return [filePart(part.file, part.filename)];
    case 'audio': return [{ type: 'input_audio', input_audio: { data: part.audio.data, format: audioFormat(part.audio.media_type) } }];
    }
  });
  // The wire content union accepts a refusal part, but the pinned user-message
  // declaration narrows it away. Responses user content can carry one, so keep
  // the existing pass-through rather than dropping it.
  return parts as OpenAIChatCompletionsUserContentPart[];
};

/**
 * A Chat `tool` message admits only text, while the IR tool result may carry
 * images. The image parts are lifted into a user message that follows the
 * result, so a vision target still receives them.
 *
 * https://github.com/openai/openai-node/blob/61539248cbe04665de68a71e6fd878127ae4db87/src/resources/chat/completions/completions.ts#L1893-L1908
 * https://github.com/vercel/ai/blob/c093ee7458ccd5dada05d8461041e47c24ee55c0/packages/google/src/convert-to-google-messages.ts#L137-L180
 */
export const openaiChatCompletionsToolResultContent = (
  callId: string,
  output: string | readonly IRInputToolResultContentPart[],
): { readonly content: string; readonly lifted: OpenAIChatCompletionsUserContentPart[] } => {
  if (typeof output === 'string') return { content: output, lifted: [] };
  if (output.some(part => part.type === 'file')) throw new TranslatorInputError('Cannot translate input_file tool output to OpenAI Chat Completions.');
  const text = output.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
  const images = output.flatMap(part => part.type === 'image' ? [imageUrlPart(part.image, part.detail)] : []);
  return images.length === 0
    ? { content: text, lifted: [] }
    : {
        content: text === '' ? 'Image output is attached in the following user message.' : text,
        lifted: [{ type: 'text', text: `Image output from tool call ${callId}:` }, ...images],
      };
};

const assistantMessage = (items: readonly IRInputAssistantItem[]): OpenAIChatCompletionsMessage[] => {
  const text: string[] = [];
  const refusals: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: OpenAIChatCompletionsToolCall[] = [];
  for (const item of items) {
    switch (item.type) {
    case 'message':
      for (const part of item.content) if (part.type === 'text') text.push(part.text); else refusals.push(part.refusal);
      break;
    case 'reasoning':
      // `reasoning_text` is the extension the gateway already emits for
      // translated output; it is a target-only spelling here because no reader
      // can identify which alias a Chat source meant.
      if (item.summary !== undefined) reasoning.push(item.summary.join(''));
      if (item.content !== undefined) reasoning.push(item.content.join(''));
      break;
    case 'function_call':
      toolCalls.push({
        id: item.call_id,
        type: 'function',
        // Chat requires an `arguments` string; an absent argument object is
        // spelled `undefined` on the wire as before.
        function: { name: item.name, arguments: item.arguments as string },
      });
      break;
    case 'custom_tool_call':
      // Chat Completions must express a freeform tool call as a function call
      // whose single argument is `input`; the surrounding route restores the
      // custom shape on the response path.
      toolCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: JSON.stringify({ input: item.input }) } });
      break;
    }
  }
  // A turn with no text, tool calls, or reasoning carries nothing.
  if (text.length === 0 && toolCalls.length === 0 && reasoning.length === 0) return [];
  // A turn carrying reasoning or tool calls with no text spells its content as
  // null; a turn with neither is an explicitly empty message and keeps ''.
  return [{
    role: 'assistant',
    content: text.length === 0 && (toolCalls.length > 0 || reasoning.length > 0) ? null : text.join('\n\n'),
    ...(refusals.length === 0 ? {} : { refusal: refusals.join('\n\n') }),
    ...(reasoning.length === 0 ? {} : { reasoning_text: reasoning.join('') }),
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  }];
};

const userMessages = (
  items: readonly IRInputUserItem[],
  legacyFunctionNames?: ReadonlyMap<string, string>,
): OpenAIChatCompletionsMessage[] => {
  // Images lifted out of consecutive tool results gather into one user message
  // after the run, so a tool-call group stays contiguous.
  const messages: OpenAIChatCompletionsMessage[] = [];
  let pendingImages: OpenAIChatCompletionsUserContentPart[] = [];
  const flushImages = (): void => {
    if (pendingImages.length === 0) return;
    messages.push({ role: 'user', content: pendingImages });
    pendingImages = [];
  };
  for (const item of items) {
    if (item.type !== 'tool_result') flushImages();
    messages.push(...openaiChatCompletionsUserItem(item, lifted => pendingImages.push(...lifted), legacyFunctionNames));
  }
  flushImages();
  return messages;
};

const openaiChatCompletionsUserItem = (
  item: IRInputUserItem,
  lift: (parts: readonly OpenAIChatCompletionsUserContentPart[]) => void,
  legacyFunctionNames?: ReadonlyMap<string, string>,
): OpenAIChatCompletionsMessage[] => [item].flatMap<OpenAIChatCompletionsMessage>(item => {
  switch (item.type) {
  case 'message':
    return [item.role === 'user'
      ? { role: 'user', content: userContent(item) }
      // A single text part collapses to the string spelling Chat accepts for
      // text-only system/developer messages; several parts keep their array so
      // block boundaries survive.
      : { role: item.role, content: item.content.length === 1 ? item.content[0].text : item.content.map(part => ({ type: 'text' as const, text: part.text })) }];
  case 'tool_result': {
    const projected = openaiChatCompletionsToolResultContent(item.call_id, item.output);
    lift(projected.lifted);
    const legacyName = legacyFunctionNames?.get(item.call_id);
    return [legacyName === undefined
      ? { role: 'tool', tool_call_id: item.call_id, content: projected.content }
      : { role: 'function', name: legacyName, content: projected.content }];
  }
  }
});

export interface OpenAIChatCompletionsFromIROptions {
  /**
   * A resolved assistant turn may carry a legacy single `function_call`, whose
   * later tool messages must use the legacy `function` role. The route owns
   * that mapping because only it sees the resolved native turn.
   */
  readonly legacyFunctionNames?: ReadonlyMap<string, string>;
}

export const openaiChatCompletionsFromIR = (
  conversation: IRInputConversation,
  options: OpenAIChatCompletionsFromIROptions = {},
): OpenAIChatCompletionsMessage[] => conversation.turns.flatMap(turn => turn.role === 'assistant'
  ? assistantMessage(turn.items)
  : userMessages(turn.items, options.legacyFunctionNames));

/**
 * Chat Completions has no top-level instructions slot, so a leading system run
 * stays an ordinary message there.
 */
export const openaiChatCompletionsTurnFromIR = (turn: IRInputConversation['turns'][number]): OpenAIChatCompletionsMessage[] => turn.role === 'assistant'
  ? assistantMessage(turn.items)
  : userMessages(turn.items);

export type { OpenAIChatCompletionsContentPart };
