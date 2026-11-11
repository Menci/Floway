import type { IRInputAddressedAssistantItem, IRInputAddressedTurn } from '../../../ir/input/addressed.ts';
import { irInputToolChoiceForTools } from '../../../ir/input/select-tools.ts';
import { requireStreaming } from '../../../ir/input/stream.ts';
import type { IRInputRequestHeader, IRInputSettings, IRInputTool, IRInputToolChoice, IRInputMedia, IRInputTextPart, IRInputToolResultContentPart, IRInputClientItem } from '../../../ir/input/types.ts';
import { TranslatorInputError } from '../../../types.ts';
import { buildCustomToolInputSchema } from '../../custom-tool.ts';
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
  case 'url': {
    // Messages states a URL as a URL. Anything else here is a caller error
    // rather than an upstream preference, so it fails instead of being written.
    const scheme = media.url.slice(0, media.url.indexOf(':'));
    if (scheme !== 'http' && scheme !== 'https') {
      throw new TranslatorInputError(`Messages image input requires an http or https URL, got '${media.url}'.`);
    }
    return { type: 'url', url: media.url };
  }
  case 'file': return { type: 'file', file_id: media.file_id };
  case 'base64':
    if (media.media_type === undefined) throw new TranslatorInputError('Anthropic Messages image input requires a media type.');
    return { type: 'base64', media_type: media.media_type as Extract<AnthropicMessagesImageSource, { type: 'base64' }>['media_type'], data: media.data };
  }
};

const imageBlock = (media: IRInputMedia): AnthropicMessagesImageBlock => ({ type: 'image', source: imageSource(media) });

/**
 * The text a base64 payload decodes to.
 *
 * The IR keeps every media payload base64-encoded, while a Messages `text`
 * document source states the document's characters directly. Writing the
 * encoded bytes there would send the encoding itself as the document.
 */
const textOfBase64 = (data: string): string => {
  const binary = atob(data);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

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
      ? { type: 'document', source: { type: 'text', media_type: 'text/plain', data: textOfBase64(media.data) } }
      : { type: 'document', source: { type: 'base64', media_type: media.media_type, data: media.data } };
  }
  }
};

const systemContent = (content: readonly IRInputTextPart[]): AnthropicMessagesTextBlockParam[] => content.map(part => ({ type: 'text', text: part.text }));

const userContent = (
  item: Extract<IRInputClientItem, { type: 'message' }>,
): AnthropicMessagesUserContentBlock[] => {
  const blocks: AnthropicMessagesUserContentBlock[] = [];
  for (const part of item.content) {
    switch (part.type) {
    case 'text': blocks.push({ type: 'text', text: part.text }); break;
    case 'image': blocks.push(imageBlock(part.image)); break;
    case 'file':
      blocks.push(documentBlock(part.file));
      break;
    case 'audio': throw new TranslatorInputError(`Cannot translate an audio part of MIME type '${part.audio.media_type}' to Anthropic Messages.`);
    default: throw new TranslatorInputError(`Invalid '${(part as { type: string }).type}' content part.`);
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
    if (part.type === 'file') throw new TranslatorInputError('Cannot translate file tool output to Anthropic Messages.');
    blocks.push(imageBlock(part.image));
  }
  // Messages spells an empty tool result as the empty string.
  return blocks.length === 0 ? '' : blocks;
};

const assistantBlocks = (items: readonly IRInputAddressedAssistantItem[]): AnthropicMessagesAssistantInputContentBlock[] => {
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
        // `input` is required on this wire, and a call that takes no argument
        // object states the empty one — the spelling every target uses for it.
        input: item.arguments === undefined ? {} : parseArguments(item.arguments),
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

// Messages needs an object, so a call whose arguments are not an object keeps
// the raw text under `raw_arguments` rather than dropping the history. A JSON
// `null`, an array, and malformed text all take that path: none of them is an
// argument object, and discarding the call would lose what the model said.
const parseArguments = (argumentsJson: string): Record<string, unknown> => {
  // An out-of-range JSON number such as `1e400` parses to `Infinity` and would
  // serialize back as `null`. Parsing with raw-number preservation keeps the
  // caller's exact token.
  try {
    const parsed = parseJSONWithRawNumbers(argumentsJson);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { raw_arguments: argumentsJson };
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
    throw new TranslatorInputError(`Anthropic Messages cannot express an allowed_tools ${choice.mode} subset of ${choice.tools.length} tools.`);
  }
  return { type: 'tool', name: choice.name };
};

export interface AnthropicMessagesRequestFromIROptions {
  // The upstream's own output limit, when the operator knows it. Messages
  // requires a ceiling and the source may not have stated one.
  readonly fallbackMaxOutputTokens?: number;
}

/**
 * One segment's messages and the system blocks a leading prompt run lifts.
 *
 * Messages keeps the system prompt in its own top-level field. A leading system
 * run is lifted there, one block per source text part so the boundaries
 * survive; later system messages stay inline at their position.
 *
 * Reading holds `hoisting` across a whole conversation — once anything but a
 * leading prompt is reached, later prompts stay inline. A segment therefore
 * states whether it may still hoist, which is what keeps a split conversation
 * reading the same as an unsplit one.
 */
export interface AnthropicMessagesConversation {
  readonly messages: AnthropicMessagesMessage[];
  readonly system: AnthropicMessagesTextBlockParam[];
}

export const anthropicMessagesConversationFromIR = (
  turns: readonly IRInputAddressedTurn[],
  leading: boolean,
): AnthropicMessagesConversation => {
  const system: AnthropicMessagesTextBlockParam[] = [];
  let hoisting = leading;
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
    const turnBlocks: AnthropicMessagesUserContentBlock[] = [];
    for (const item of turn.items) {
      if (item.type === 'prompt') {
        if (hoisting) {
          system.push(...systemContent(item.content));
          continue;
        }
        // Messages states a system message's content as a non-empty block list
        // or a bare string; an empty prompt run is the empty string.
        const blocks = systemContent(item.content);
        messages.push({ role: 'system', content: blocks.length === 0 ? '' : blocks });
        continue;
      }
      hoisting = false;
      turnBlocks.push(...(item.type === 'tool_result'
        ? [{ type: 'tool_result' as const, tool_use_id: item.call_id, content: toolResultContent(item.output), ...(item.is_error === true ? { is_error: true } : {}) }]
        : userContent(item)));
    }
    append(turnBlocks);
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
  options: AnthropicMessagesRequestFromIROptions = {},
): Omit<AnthropicMessagesPayload, 'messages' | 'system'> => {
  const tools = request.tools;
  const choice = irInputToolChoiceForTools(request.tool_choice, tools);
  return {
    ...anthropicMessagesSettingsFromIR(request.settings),
    model: request.settings.model,
    max_tokens: request.settings.max_output_tokens ?? options.fallbackMaxOutputTokens ?? ANTHROPIC_MESSAGES_FALLBACK_MAX_TOKENS,
    // A trip guarantees a streaming request; a request that says otherwise
    // cannot be carried by this side at all.
    stream: requireStreaming(request.settings),
    ...(tools === undefined || tools.length === 0 ? {} : { tools: tools.map(toolFromIR) }),
    ...(choice === undefined ? {} : { tool_choice: toolChoiceFromIR(choice, tools ?? []) }),
  };
};

/**
 * Messages states one ceiling, `max_tokens`, and its structured-output schema
 * lives in `output_config.format`. It accepts neither `seed` nor Chat's
 * `max_completion_tokens` spelling, so a source that only stated the latter
 * still lands here as `max_tokens`.
 */
export const anthropicMessagesSettingsFromIR = (settings: IRInputSettings): Omit<Partial<AnthropicMessagesPayload>, 'model'> => {
  const ceiling = settings.max_output_tokens;
  const format = settings.output_format;
  const formatConfig = format?.type === 'json_schema' && format.schema !== undefined
    ? { format: { type: 'json_schema' as const, schema: format.schema } }
    : undefined;

  // Anthropic splits the single effort axis across two slots: `thinking` and
  // `output_config.effort`. A stated budget is the more specific quantity, so it
  // decides the thinking slot — zero being this axis's off switch — while the
  // level states the effort. With no budget, an effort of `none` moves to the
  // off switch, because this scale has no `none` of its own. Whether the target
  // honours the off switch is the target's business.
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
