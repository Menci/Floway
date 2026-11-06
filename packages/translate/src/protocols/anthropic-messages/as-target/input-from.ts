import { irInputToolChoiceForTools, irInputToolsForChoice } from '../../../ir/input/select-tools.ts';
import type {
  IRInputAssistantContentPart,
  IRInputAssistantItem,
  IRInputRequest,
  IRInputSettings,
  IRInputTool,
  IRInputToolChoice,
  IRInputMedia,
  IRInputTextPart,
  IRInputToolResultContentPart,
  IRInputUserItem,
} from '../../../ir/input/types.ts';
import { buildCustomToolInputSchema } from '../../../shared/custom-tool.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
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
 * adapter, so it stays out of the input IR value.
 *
 * A URL the loader cannot resolve is dropped instead of failing the request:
 * the prompt remains usable and the caller sees no image rather than an error.
 */
export type AnthropicMessagesImageResolver = (media: IRInputMedia) => Promise<AnthropicMessagesImageBlock | null>;

/**
 * The wire distinguishes a plain-text document from a binary one and carries the
 * binary MIME type as a string, so the caller's media type travels verbatim and
 * the selected upstream decides whether it accepts it. Rewriting an unknown type
 * to PDF would describe the bytes wrongly.
 */
const documentBlock = (media: IRInputMedia): AnthropicMessagesUserContentBlock => {
  switch (media.source_kind) {
  case 'url': return { type: 'document', source: { type: 'url', url: media.url } };
  case 'file': return { type: 'document', source: { type: 'file', file_id: media.file_id } };
  case 'base64': {
    if (media.media_type === undefined) throw new TranslatorInputError('Anthropic Messages document input requires a media type.');
    return media.media_type === 'text/plain'
      ? { type: 'document', source: { type: 'text', media_type: 'text/plain', data: media.data } }
      : { type: 'document', source: { type: 'base64', media_type: media.media_type, data: media.data } };
  }
  }
};

const systemContent = (content: readonly IRInputTextPart[]): AnthropicMessagesTextBlockParam[] => content.map(part => ({ type: 'text', text: part.text }));

const userContent = async (
  item: Extract<IRInputUserItem, { type: 'message' }>,
  options: AnthropicMessagesRequestFromIROptions,
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
      blocks.push(documentBlock(part.file));
      break;
    case 'audio': throw new TranslatorInputError(`Cannot translate Gemini generateContent inlineData MIME type '${part.audio.media_type}' to Anthropic Messages.`);
    default: throw new TranslatorInputError(`Invalid '${(part as { type: string }).type}' content part.`);
    }
  }
  // Messages' user content is a non-empty block list in the same way.
  return blocks.length === 0 ? [{ type: 'text', text: '' }] : blocks;
};

const toolResultContent = async (
  output: string | readonly IRInputToolResultContentPart[],
  options: AnthropicMessagesRequestFromIROptions,
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

// A neutral declaration becomes a Messages client tool: its JSON Schema moves
// under `input_schema`, and a freeform tool keeps the same shape because
// Messages has one declaration form for both callable kinds.
const toolFromIR = (tool: IRInputTool): AnthropicMessagesClientTool => {
  const schema = tool.type === 'function'
    ? tool.parameters ?? { type: 'object', properties: {} }
    : buildCustomToolInputSchema(tool.format);
  // Messages states a declaration's schema as an object; anything else cannot be
  // expressed as a tool here.
  if (schema.type !== 'object') throw new TranslatorInputError('Anthropic Messages function tools require an object input schema.');
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    input_schema: schema as AnthropicMessagesClientTool['input_schema'],
    ...(tool.type === 'function' && tool.strict !== undefined ? { strict: tool.strict } : {}),
  };
};

const toolChoiceFromIR = (choice: IRInputToolChoice): NonNullable<AnthropicMessagesPayload['tool_choice']> => {
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  // Messages has no declaration-level restriction: `allowed_tools` becomes the
  // matching mode, and the narrowed declaration list is applied by the caller.
  if (choice.type === 'allowed_tools') return choice.mode === 'required' ? { type: 'any' } : { type: 'auto' };
  return { type: 'tool', name: choice.name };
};

export interface AnthropicMessagesRequestFromIROptions {
  // Injected by the caller, not derived from the request: Messages sometimes has
  // to fetch a remote image before it can state one.
  readonly resolveImage?: AnthropicMessagesImageResolver;
  // The upstream's own output limit, when the operator knows it. Messages
  // requires a ceiling and the source may not have stated one.
  readonly fallbackMaxOutputTokens?: number;
}

/**
 * Messages keeps the system prompt in its own top-level field. A leading system
 * run is lifted there, one block per source text part so the boundaries
 * survive; later system messages stay inline at their position.
 *
 * The whole request comes from the IR, so this writer states every field the
 * payload carries and a route has nothing to patch onto its result.
 */
export const anthropicMessagesRequestFromIR = async (
  request: IRInputRequest,
  options: AnthropicMessagesRequestFromIROptions = {},
): Promise<AnthropicMessagesPayload> => {
  const { conversation } = request;
  const system: AnthropicMessagesTextBlockParam[] = [];
  let hoisting = true;
  const messages: AnthropicMessagesMessage[] = [];
  // Messages spells a single text block as a bare string, which is the shape a
  // client sees for a plain user turn.
  const userMessage = (blocks: AnthropicMessagesUserContentBlock[]): AnthropicMessagesMessage => ({
    role: 'user',
    content: blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks,
  });
  // One IR turn becomes one message: the items inside it belong together, and a
  // turn boundary is what keeps two runs apart. The IR states that grouping, so
  // the writer never re-derives it from item kinds.
  const append = (blocks: AnthropicMessagesUserContentBlock[]): void => {
    if (blocks.length > 0) messages.push(userMessage(blocks));
  };
  for (const turn of conversation.turns) {
    if (turn.role === 'assistant') {
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
    const turnBlocks: AnthropicMessagesUserContentBlock[] = [];
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
      turnBlocks.push(...(item.type === 'tool_result'
        ? [{ type: 'tool_result' as const, tool_use_id: item.call_id, content: await toolResultContent(item.output, options), ...(item.is_error === true ? { is_error: true } : {}) }]
        : await userContent(item, options)));
    }
    append(turnBlocks);
  }
  // Messages has no declaration-level selector: a narrowed declaration list is
  // how this wire states which callables the model may pick from, and the
  // choice itself carries only the mode.
  const selectedTools = irInputToolsForChoice(request.tools, request.tool_choice);
  const choice = irInputToolChoiceForTools(request.tool_choice, selectedTools);

  return {
    ...anthropicMessagesSettingsFromIR(request.settings),
    model: request.settings.model,
    max_tokens: request.settings.max_output_tokens ?? options.fallbackMaxOutputTokens ?? ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS,
    messages,
    ...(system.length === 0 ? {} : { system }),
    // The gateway always translates a stream; the source flag only says how
    // the client wants its own response framed.
    stream: true,
    ...(selectedTools === undefined || selectedTools.length === 0 ? {} : { tools: selectedTools.map(toolFromIR) }),
    ...(choice === undefined ? {} : { tool_choice: toolChoiceFromIR(choice) }),
  };
};

export type { IRInputAssistantContentPart };

/**
 * Messages states one ceiling, `max_tokens`, and its structured-output schema
 * lives in `output_config.format`. It has no `seed` and no `max_tokens` alias,
 * so a source that only stated `max_completion_tokens` still lands here.
 */
export const anthropicMessagesSettingsFromIR = (settings: IRInputSettings): Omit<Partial<AnthropicMessagesPayload>, 'model'> => {
  const ceiling = settings.max_output_tokens;
  const format = settings.output_format;
  const formatConfig = format?.type === 'json_schema' && format.schema !== undefined
    ? { format: { type: 'json_schema' as const, schema: format.schema } }
    : undefined;

  // Anthropic splits the single effort axis across two slots: `thinking.type:
  // 'disabled'` is the off switch, and every other level is `output_config.effort`.
  // Its scale has no `none`, so that one value changes slot rather than passing
  // through. Whether the target honours the off switch is the target's business.
  // https://platform.claude.com/docs/en/build-with-claude/effort
  const thinking = settings.reasoning_effort === 'none'
    ? { type: 'disabled' as const }
    : settings.reasoning_dynamic === true
      ? { type: 'adaptive' as const }
      : settings.reasoning_budget === undefined
        ? undefined
        // A token budget is the other half of the same axis: Messages states it
        // on an enabled thinking mode.
        : { type: 'enabled' as const, budget_tokens: settings.reasoning_budget };
  const effort = settings.reasoning_effort === undefined || settings.reasoning_effort === 'none' ? undefined : settings.reasoning_effort;
  const outputConfig = effort === undefined && formatConfig === undefined
    ? undefined
    : { ...(effort === undefined ? {} : { effort }), ...(formatConfig ?? {}) };

  return {
    ...(ceiling === undefined ? {} : { max_tokens: ceiling }),
    ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
    ...(settings.top_p === undefined ? {} : { top_p: settings.top_p }),
    ...(settings.top_k === undefined ? {} : { top_k: settings.top_k }),
    ...(settings.stop === undefined ? {} : { stop_sequences: [...settings.stop] }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(outputConfig === undefined ? {} : { output_config: outputConfig }),
    // Anthropic spells the accelerated lane as `speed: 'fast'`; every other tier
    // stays an open string on `service_tier`.
    // https://docs.claude.com/en/build-with-claude/fast-mode
    ...(settings.service_tier === undefined ? {} : isFastServiceTier(settings.service_tier) ? { speed: 'fast' as const } : { service_tier: settings.service_tier }),
  };
};
