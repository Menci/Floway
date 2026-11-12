import { parseDataURL, type ParsedDataURL } from './data-url.ts';
import type { IRInputAssistantItemWithCallIds, IRInputTurnWithCallIds } from '../../../composition/request/call-ids.ts';
import { requireStreaming } from '../../../ir/input/streaming.ts';
import type { IRInputRequestHeader, IRInputSettings, IRInputTool, IRInputToolChoice, IRInputDocument, IRInputMedia, IRInputTextPart, IRInputToolResultContentPart, IRInputClientItem } from '../../../ir/input/types.ts';
import { buildCustomToolInputSchema } from '../../../shared/custom-tool.ts';
import { TranslateInputException } from '../../../shared/input-error.ts';
import { type TranslateOptions } from '../../../types.ts';
import type {
  AnthropicMessagesAssistantInputContentBlock,
  AnthropicMessagesClientTool,
  AnthropicMessagesImageBlock,
  AnthropicMessagesImageSource,
  AnthropicMessagesMessage,
  AnthropicMessagesPayload,
  AnthropicMessagesTextBlockParam,
  AnthropicMessagesToolResultContentBlock,
  AnthropicMessagesUserContentBlock,
} from '@floway-dev/protocols/anthropic-messages';
import { ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS } from '@floway-dev/protocols/anthropic-messages';
import { isFastServiceTier, parseJSONWithRawNumbers } from '@floway-dev/protocols/common';

const requiredMediaType = (media: ParsedDataURL): string => media.media_type ?? 'application/octet-stream';

const inlineMedia = (media: Extract<IRInputMedia, { source_kind: 'data' | 'base64' }>): ParsedDataURL => {
  if (media.source_kind === 'base64') return media;
  return media.data.startsWith('data:') ? parseDataURL(media.data) : { data: media.data };
};

const imageSource = (media: IRInputMedia): AnthropicMessagesImageSource => {
  switch (media.source_kind) {
  case 'url': {
    if (media.url.startsWith('data:')) {
      const inline = parseDataURL(media.url);
      return { type: 'base64', media_type: requiredMediaType(inline) as Extract<AnthropicMessagesImageSource, { type: 'base64' }>['media_type'], data: inline.data };
    }
    // Messages remote images require HTTP(S) URLs; invalid schemes are translation input errors.
    const scheme = media.url.slice(0, media.url.indexOf(':')).toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      throw new TranslateInputException(`Messages image input requires an http or https URL, got '${media.url}'.`);
    }
    return { type: 'url', url: media.url };
  }
  case 'file': return { type: 'file', file_id: media.file_id };
  case 'data':
  case 'base64': {
    const inline = inlineMedia(media);
    return { type: 'base64', media_type: requiredMediaType(inline) as Extract<AnthropicMessagesImageSource, { type: 'base64' }>['media_type'], data: inline.data };
  }
  }
};

const imageBlock = (media: IRInputMedia): AnthropicMessagesImageBlock => ({ type: 'image', source: imageSource(media) });

/**
 * Inline documents remain bytes. The target requires a media type, so an
 * untyped raw base64 value receives the generic binary type at this boundary.
 */
const mediaDocumentBlock = (media: IRInputMedia): Extract<AnthropicMessagesUserContentBlock, { type: 'document' }> => {
  switch (media.source_kind) {
  case 'url': {
    if (!media.url.startsWith('data:')) return { type: 'document', source: { type: 'url', url: media.url } };
    const inline = parseDataURL(media.url);
    return { type: 'document', source: { type: 'base64', media_type: requiredMediaType(inline), data: inline.data } };
  }
  case 'file': return { type: 'document', source: { type: 'file', file_id: media.file_id } };
  case 'data':
  case 'base64': {
    const inline = inlineMedia(media);
    return { type: 'document', source: { type: 'base64', media_type: requiredMediaType(inline), data: inline.data } };
  }
  }
};

const documentBlock = (document: IRInputDocument): Extract<AnthropicMessagesUserContentBlock, { type: 'document' }> => {
  const source = document.source;
  if (source.source_kind === 'media') return mediaDocumentBlock(source.media);
  if (source.source_kind === 'text') {
    return { type: 'document', source: { type: 'text', media_type: source.media_type, data: source.text } };
  }
  return {
    type: 'document',
    source: {
      type: 'content',
      content: source.content.map(part => part.type === 'text'
        ? { type: 'text' as const, text: part.text }
        : imageBlock(part.image)),
    },
  };
};

const systemContent = (content: readonly IRInputTextPart[]): AnthropicMessagesTextBlockParam[] => content.map(part => ({ type: 'text', text: part.text }));

const userContent = (
  item: Extract<IRInputClientItem, { type: 'message'; role: 'user' }>,
): AnthropicMessagesUserContentBlock[] => {
  const blocks: AnthropicMessagesUserContentBlock[] = [];
  for (const part of item.content) {
    switch (part.type) {
    case 'text': blocks.push({ type: 'text', text: part.text }); break;
    case 'image': blocks.push(imageBlock(part.image)); break;
    case 'file':
      blocks.push(mediaDocumentBlock(part.file));
      break;
    case 'document':
      blocks.push(documentBlock(part.document));
      break;
    case 'audio': throw new TranslateInputException(`Cannot translate an audio part of MIME type '${part.audio.media_type}' to Anthropic Messages.`);
    default: throw new TranslateInputException(`Invalid '${(part as { type: string }).type}' content part.`);
    }
  }
  // Messages' user content is a non-empty block list in the same way.
  return blocks.length === 0 ? [{ type: 'text', text: '' }] : blocks;
};

const toolResultContent = (
  output: string | readonly IRInputToolResultContentPart[],
): string | AnthropicMessagesToolResultContentBlock[] => {
  if (typeof output === 'string') return output;
  const blocks: AnthropicMessagesToolResultContentBlock[] = [];
  for (const part of output) {
    if (part.type === 'text') { blocks.push({ type: 'text', text: part.text }); continue; }
    if (part.type === 'file') { blocks.push(mediaDocumentBlock(part.file)); continue; }
    if (part.type === 'document') { blocks.push(documentBlock(part.document)); continue; }
    blocks.push(imageBlock(part.image));
  }
  // Messages spells an empty tool result as the empty string.
  return blocks.length === 0 ? '' : blocks;
};

const assistantBlocks = (items: readonly IRInputAssistantItemWithCallIds[]): AnthropicMessagesAssistantInputContentBlock[] => {
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
      // Project readable reasoning summaries into Messages thinking blocks; opaque signed replay state uses sidecars.
      return item.summary === undefined ? [] : [{ type: 'thinking', thinking: item.summary.join(''), signature: '' }];
    }
    case 'function_call':
      return [{
        type: 'tool_use' as const,
        id: item.call_id,
        name: item.name,
        // Messages requires input; an absent argument object is written as {}.
        input: item.arguments === undefined ? {} : parseArguments(item.arguments),
      }] as AnthropicMessagesAssistantInputContentBlock[];
    case 'custom_tool_call':
      // Messages has no freeform tool call; the wrapper schema a custom tool is
      // declared with takes one `input` string, so the call is projected onto it.
      return [{ type: 'tool_use', id: item.call_id, name: item.name, input: { input: item.input } }];
    }
  });
  return blocks;
};

// Messages accepts any JSON tool input. Malformed JSON keeps its raw text under
// `raw_arguments` so the historical call is not discarded.
const parseArguments = (argumentsJson: string): unknown => {
  // An out-of-range JSON number such as `1e400` parses to `Infinity` and would
  // serialize back as `null`. Parsing with raw-number preservation keeps the
  // caller's exact token.
  try {
    const parsed = parseJSONWithRawNumbers(argumentsJson);
    return parsed;
  } catch {
    return { raw_arguments: argumentsJson };
  }
};

const toolFromIR = (tool: IRInputTool): AnthropicMessagesClientTool => {
  const schema = tool.type === 'function'
    ? tool.parameters ?? { type: 'object', properties: {} }
    : buildCustomToolInputSchema(tool.format);
  if (schema.type !== 'object') throw new TranslateInputException('Anthropic Messages function tools require an object input schema.');
  return {
    // Messages states this kind for a declaration that is not one of its own
    // native tool types, which is every declaration this IR carries.
    type: 'custom',
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    input_schema: { ...schema, type: 'object' },
    ...(tool.type === 'function' && tool.strict !== undefined ? { strict: tool.strict } : {}),
  };
};

const toolChoiceFromIR = (choice: IRInputToolChoice, tools: readonly IRInputTool[]): NonNullable<AnthropicMessagesPayload['tool_choice']> => {
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  if (choice.type === 'allowed_tools') {
    if (choice.mode === 'required' && choice.tools.length === 1) return { type: 'tool', name: choice.tools[0].name };
    if (choice.mode === 'auto' && choice.tools.length === 0) return { type: 'none' };
    const permitted = new Set(choice.tools.map(tool => `${tool.type}:${tool.name}`));
    if (tools.every(tool => permitted.has(`${tool.type}:${tool.name}`))) return { type: choice.mode === 'required' ? 'any' : 'auto' };
    throw new TranslateInputException(`Anthropic Messages cannot express an allowed_tools ${choice.mode} subset of ${choice.tools.length} tools.`);
  }
  return { type: 'tool', name: choice.name };
};

const toolChoiceForTools = (choice: IRInputToolChoice | undefined, tools: readonly IRInputTool[] | undefined): IRInputToolChoice | undefined => {
  if (tools !== undefined && tools.length > 0) return choice;
  if (choice === 'none' || choice === 'auto' || choice === 'required') return choice;
  if (typeof choice === 'object' && choice.type === 'allowed_tools' && choice.mode === 'auto') return 'none';
  return undefined;
};

/**
 * One segment's messages and the system blocks lifted from its instruction.
 *
 * Messages keeps instructions in its top-level system field, one block per
 * source text part so the boundaries
 * survive; later system messages stay inline at their position.
 *
 * Only the segment opening the whole conversation may hoist. Splitting at a
 * restored assistant turn must not promote a later system message merely because
 * it opens another segment.
 */
export interface AnthropicMessagesConversation {
  readonly messages: AnthropicMessagesMessage[];
  readonly system: AnthropicMessagesTextBlockParam[];
}

export const anthropicMessagesConversationFromIR = (
  turns: readonly IRInputTurnWithCallIds[],
  leading: boolean,
): AnthropicMessagesConversation => {
  const system: AnthropicMessagesTextBlockParam[] = [];
  let hoisting = leading;
  const messages: AnthropicMessagesMessage[] = [];

  const userMessage = (blocks: AnthropicMessagesUserContentBlock[]): AnthropicMessagesMessage => ({
    role: 'user',
    content: blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks,
  });
  // Turn boundaries control user-message grouping; item kinds do not create new client turns.
  const append = (blocks: AnthropicMessagesUserContentBlock[]): void => {
    if (blocks.length > 0) messages.push(userMessage(blocks));
  };
  for (const turn of turns) {
    if (turn.kind === 'assistant') {
      hoisting = false;
      const blocks = assistantBlocks(turn.items);
      // A turn whose every item was dropped contributes no message, but the user
      // turns around it were never adjacent, so a following user item must not
      // merge into the previous message. An explicitly empty text item is not
      // dropped: `assistantBlocks` emitted one empty block for it.
      if (blocks.length === 0) continue;
      const content = blocks.length === 1 && blocks[0].type === 'text' && blocks[0].text === '' ? '' : blocks;
      messages.push({ role: 'assistant', content });
      continue;
    }
    const toolResultBlocks: AnthropicMessagesUserContentBlock[] = [];
    const userBlocks: AnthropicMessagesUserContentBlock[] = [];
    for (const item of turn.items) {
      if (item.type === 'instruction') {
        if (hoisting) {
          system.push(...systemContent(item.content));
          hoisting = false;
          continue;
        }
        const blocks = systemContent(item.content);
        messages.push({ role: 'system', content: blocks.length === 0 ? '' : blocks });
        continue;
      }
      if (item.type === 'message' && item.role !== 'user') {
        if (hoisting) {
          system.push(...systemContent(item.content));
          continue;
        }
        // Messages states a system message's content as a non-empty block list
        // or a bare string; an empty message is the empty string.
        const blocks = systemContent(item.content);
        messages.push({ role: 'system', content: blocks.length === 0 ? '' : blocks });
        continue;
      }
      hoisting = false;
      if (item.type === 'tool_result') {
        toolResultBlocks.push({ type: 'tool_result', tool_use_id: item.call_id, content: toolResultContent(item.output), ...(item.is_error === true ? { is_error: true } : {}) });
      } else {
        userBlocks.push(...userContent(item as Extract<IRInputClientItem, { type: 'message'; role: 'user' }>));
      }
    }
    append([...toolResultBlocks, ...userBlocks]);
  }
  return { messages, system };
};

/**
 * Everything a Messages request states except its conversation.
 *
 * The conversation is written separately because a trip interleaves it with the
 * assistant turns a sidecar already resolved, so only this half is computed once
 * per payload.
 */
export const anthropicMessagesHeaderFromIR = (
  request: IRInputRequestHeader,
  options: Pick<TranslateOptions, 'fallbackMaxOutputTokens'> = {},
): Omit<AnthropicMessagesPayload, 'messages' | 'system'> => {
  const tools = request.tools;
  const choice = toolChoiceForTools(request.tool_choice, tools);
  const selected = choice === undefined ? undefined : toolChoiceFromIR(choice, tools ?? []);
  const parallel = request.settings.parallel_tool_calls ?? undefined;
  const toolChoice = tools === undefined || tools.length === 0 || parallel === undefined || selected?.type === 'none'
    ? selected
    : { ...(selected ?? { type: 'auto' as const }), disable_parallel_tool_use: !parallel };
  return {
    ...anthropicMessagesSettingsFromIR(request.settings),
    model: request.settings.model,
    max_tokens: request.settings.max_output_tokens ?? request.settings.max_visible_output_tokens
      ?? options.fallbackMaxOutputTokens ?? ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS,
    // A trip guarantees a streaming request; a request that says otherwise
    // cannot be carried by this side at all.
    stream: requireStreaming(request.settings),
    ...(tools === undefined || tools.length === 0 ? {} : { tools: tools.map(toolFromIR) }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  };
};

export const anthropicMessagesSettingsFromIR = (settings: IRInputSettings): Omit<Partial<AnthropicMessagesPayload>, 'model'> => {
  const ceiling = settings.max_output_tokens ?? settings.max_visible_output_tokens;
  const format = settings.output_format;
  const formatConfig = format?.type === 'json_schema' && format.schema !== undefined
    ? { format: { type: 'json_schema' as const, schema: format.schema } }
    : undefined;

  // Messages separates thinking mode and budget from output_config.effort. Dynamic thinking takes precedence over a numeric budget.
  // https://platform.claude.com/docs/en/build-with-claude/effort
  const thinking = settings.reasoning_budget_dynamic === true
    ? { type: 'adaptive' as const }
    : settings.reasoning_budget !== undefined
      ? settings.reasoning_budget === 0
        ? { type: 'disabled' as const }
        : { type: 'enabled' as const, budget_tokens: settings.reasoning_budget }
      : settings.reasoning_effort === 'none'
        ? { type: 'disabled' as const }
        : undefined;
  const effort = settings.reasoning_effort === undefined || settings.reasoning_effort === 'none' ? undefined : settings.reasoning_effort;
  const outputConfig = effort === undefined && formatConfig === undefined
    ? undefined
    : { ...(effort === undefined ? {} : { effort }), ...(formatConfig ?? {}) };

  return {
    ...(ceiling == null ? {} : { max_tokens: ceiling }),
    ...(settings.temperature == null ? {} : { temperature: settings.temperature }),
    ...(settings.top_p == null ? {} : { top_p: settings.top_p }),
    ...(settings.top_k === undefined ? {} : { top_k: settings.top_k }),
    ...(settings.stop === undefined ? {} : { stop_sequences: [...settings.stop] }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(outputConfig === undefined ? {} : { output_config: outputConfig }),
    // Anthropic spells the accelerated lane as `speed: 'fast'`; every other tier
    // stays an open string on `service_tier`.
    // https://docs.claude.com/en/build-with-claude/fast-mode
    ...(settings.service_tier == null ? {} : isFastServiceTier(settings.service_tier) ? { speed: 'fast' as const } : { service_tier: settings.service_tier }),
  };
};
