import { klona } from 'klona/json';

import { filterAnthropicMessagesClientTools } from './client-tools.ts';
import { partitionAnthropicMessagesTurns, type AnthropicMessagesConversationTurn } from './conversation-turns.ts';
import type {
  IRInputAssistantContentPart,
  IRInputRequest,
  IRInputSettings,
  IRInputTool,
  IRInputToolChoice,
  IRInputOutputFormat,
  IRInputAssistantItem,
  IRInputConversation,
  IRInputMedia,
  IRInputTextPart,
  IRInputToolResultContentPart,
  IRInputTurn,
  IRInputUserContentPart,
  IRInputClientItem,
} from '../../../ir/input/types.ts';
import { TranslatorInputError } from '../../../translator-input-error.ts';
import type {
  AnthropicMessagesClientTool,
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
// plain text, a URL, or an embedded content array. The input IR keeps the same two
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
): IRInputClientItem[] => {
  if (message.role === 'system') {
    if (typeof message.content !== 'string' && message.content.some(block => block.type !== 'text')) {
      throw new TranslatorInputError('Only text system content is supported.');
    }
    return [{ type: 'message', role: 'system', content: textBlocks(message.content as string | readonly AnthropicMessagesTextBlockParam[]) }];
  }
  if (typeof message.content === 'string') {
    return [{ type: 'message', role: 'user', content: message.content === '' ? [] : [{ type: 'text', text: message.content }] }];
  }

  const items: IRInputClientItem[] = [];
  const pending: IRInputUserContentPart[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    items.push({ type: 'message', role: 'user', content: [...pending] });
    pending.length = 0;
  };

  // Messages keeps tool results inline with user content. Flat input IR items keep
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
  readonly downgraded: IRInputClientItem[];
}

const assistantSegments = (message: Extract<AnthropicMessagesMessage, { role: 'assistant' }>, messageIdx: number): AnthropicMessagesAssistantSegments => {
  if (typeof message.content === 'string') {
    return { assistant: message.content === '' ? [] : [{ type: 'message', content: [{ type: 'text', text: message.content }] }], downgraded: [] };
  }

  const items: IRInputAssistantItem[] = [];
  const downgraded: IRInputClientItem[] = [];
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
    // Hosted results other than search have no plain-tool spelling and no
    // cross-vendor counterpart, so the turn fails rather than losing history.
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

/**
 * Messages states one ceiling, `max_tokens`, and its structured-output schema
 * lives in `output_config.format`. `top_k` is a Messages-only sampling knob.
 */
// A Messages client declaration carries a JSON Schema under `input_schema` and
// states both callable kinds with the same shape, so the arm is the neutral one
// every target can express.
const toolToIR = (tool: AnthropicMessagesClientTool): IRInputTool => {
  const format = tool.input_schema as { type?: unknown } & Record<string, unknown>;
  return {
    type: 'function',
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    ...(format === undefined ? {} : { parameters: klona(tool.input_schema) as unknown as Readonly<Record<string, unknown>> }),
    ...(tool.strict === undefined ? {} : { strict: tool.strict }),
  };
};

const toolChoiceToIR = (choice: NonNullable<AnthropicMessagesPayload['tool_choice']>, declarations: readonly IRInputTool[]): IRInputToolChoice => {
  switch (choice.type) {
  case 'auto': return 'auto';
  case 'any': return 'required';
  case 'none': return 'none';
  default: {
    // A selector names a declaration the same request supplies; a request that
    // points at nothing cannot be translated into any target's vocabulary.
    const name = (choice as { name: string }).name;
    if (!declarations.some(tool => tool.name === name)) {
      throw new TranslatorInputError(`Anthropic Messages tool_choice names an undeclared tool: ${String(name)}`);
    }
    return { type: 'function', name };
  }
  }
};

export const anthropicMessagesToolsToIR = (payload: AnthropicMessagesPayload): Pick<IRInputRequest, 'tools' | 'tool_choice'> => {
  const clientTools = filterAnthropicMessagesClientTools(payload.tools);
  const declarations = clientTools === undefined ? [] : clientTools.map(toolToIR);
  // A selector is validated against the declarations either way: dropping one
  // that names nothing would widen what the model may call.
  const toolChoice = payload.tool_choice == null ? undefined : toolChoiceToIR(payload.tool_choice, declarations);
  return {
    ...(declarations.length === 0 ? {} : { tools: declarations }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  };
};

export const anthropicMessagesSettingsToIR = (payload: AnthropicMessagesPayload): IRInputSettings => {
  const format = payload.output_config?.format;
  // Messages' structured-output schema is already strict by contract, so the
  // fact is stated here rather than left for a target to invent. It states no
  // name, while the OpenAI wires require one; this is the established spelling.
  // https://platform.claude.com/docs/en/build-with-claude/structured-outputs
  const outputFormat: IRInputOutputFormat | undefined = format?.type === 'json_schema'
    ? { type: 'json_schema', name: 'messages_response', schema: klona(format.schema), strict: true }
    : undefined;

  const reasoningEffort = reasoningEffortFromAnthropicMessages(payload);
  return {
    model: payload.model,
    stream: payload.stream === true,
    ...(payload.temperature == null ? {} : { temperature: payload.temperature }),
    ...(payload.top_p == null ? {} : { top_p: payload.top_p }),
    ...(payload.top_k == null ? {} : { top_k: payload.top_k }),
    ...(payload.stop_sequences == null ? {} : { stop: [...payload.stop_sequences] }),
    ...(payload.max_tokens == null ? {} : { max_output_tokens: payload.max_tokens }),
    ...(outputFormat === undefined ? {} : { output_format: outputFormat }),
    ...(payload.service_tier == null ? {} : { service_tier: payload.service_tier }),
    // Messages splits one reasoning axis across three controls: a level, an off
    // switch, and a token budget. The level and the off switch are the same axis
    // every other protocol states as an effort, and the budget is its own
    // quantity that a source may state without a level.
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    ...(payload.thinking?.type === 'enabled' ? { reasoning_budget: payload.thinking.budget_tokens } : {}),
    ...(payload.thinking?.type === 'adaptive' ? { reasoning_dynamic: true } : {}),
  };
};

// A level stated outright wins over the one a thinking mode implies, because the
// caller wrote it explicitly while the mode only bounds it.
const reasoningEffortFromAnthropicMessages = (payload: AnthropicMessagesPayload): string | undefined => {
  if (payload.output_config?.effort != null) return payload.output_config.effort;
  if (payload.thinking?.type === 'disabled') return 'none';
  if (payload.thinking?.type === 'enabled' || payload.thinking?.type === 'adaptive') return 'medium';
  return undefined;
};
