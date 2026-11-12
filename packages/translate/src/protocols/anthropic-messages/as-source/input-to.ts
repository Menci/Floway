import { klona } from 'klona/json';

import { partitionAnthropicMessagesTurns, type AnthropicMessagesConversationTurn } from './conversation-turns.ts';
import type { AnthropicMessagesSourceAssistantTurn } from './round-trip.ts';
import type { SourceReading, SourceTurnSlot } from '../../../composition/reading.ts';
import type {
  IRInputAssistantContentPart,
  IRInputRequestHeader,
  IRInputSettings,
  IRInputTool,
  IRInputToolChoice,
  IRInputOutputFormat,
  IRInputAssistantItem,
  IRInputDocument,
  IRInputDocumentContentPart,
  IRInputMedia,
  IRInputTextPart,
  IRInputToolResultContentPart,
  IRInputTurn,
  IRInputUserContentPart,
  IRInputClientItem,
} from '../../../ir/input/types.ts';
import { TranslateInputException } from '../../../shared/input-error.ts';
import type {
  AnthropicMessagesAssistantInputContentBlock,
  AnthropicMessagesClientTool,
  AnthropicMessagesImageBlock,
  AnthropicMessagesMetadataEx,
  AnthropicMessagesMessage,
  AnthropicMessagesPayload,
  AnthropicMessagesSearchResultBlock,
  AnthropicMessagesTextBlockParam,
  AnthropicMessagesToolResultBlock,
  AnthropicMessagesUserContentBlock,
} from '@floway-dev/protocols/anthropic-messages';
import { FAST_SERVICE_TIER } from '@floway-dev/protocols/common';

const imageMedia = (source: AnthropicMessagesImageBlock['source']): IRInputMedia => {
  switch (source.type) {
  case 'base64': return { source_kind: 'base64', media_type: source.media_type, data: source.data };
  case 'url': return { source_kind: 'url', url: source.url };
  case 'file': return { source_kind: 'file', file_id: source.file_id };
  }
};

const textPartsToIR = (content: string | readonly AnthropicMessagesTextBlockParam[]): IRInputTextPart[] => typeof content === 'string'
  ? content === '' ? [] : [{ type: 'text', text: content }]
  : content.map(block => {
      if (block.type !== 'text') throw new TranslateInputException('Only text system content is supported.');
      return { type: 'text', text: block.text };
    });

const documentFromBlock = (block: Extract<AnthropicMessagesUserContentBlock, { type: 'document' }>): IRInputDocument => {
  const source = block.source;
  switch (source.type) {
  case 'base64': return { source: { source_kind: 'media', media: { source_kind: 'base64', media_type: source.media_type, data: source.data } } };
  case 'url': return { source: { source_kind: 'media', media: { source_kind: 'url', url: source.url } } };
  case 'file': return { source: { source_kind: 'media', media: { source_kind: 'file', file_id: source.file_id } } };
  case 'text': return { source: { source_kind: 'text', media_type: source.media_type, text: source.data } };
  case 'content': {
    const content: IRInputDocumentContentPart[] = typeof source.content === 'string'
      ? [{ type: 'text', text: source.content }]
      : source.content.map(part => {
          if (part.type === 'text') return { type: 'text' as const, text: part.text };
          if (part.type === 'image') return { type: 'image' as const, image: imageMedia(part.source) };
          throw new TranslateInputException(`'${(part as { type: string }).type}' document content block is not supported.`);
        });
    return { source: { source_kind: 'content', content } };
  }
  }
};

interface MessagePosition {
  readonly messageIdx: number;
  readonly blockIdx: number;
}

const userContentPart = (
  block: Exclude<AnthropicMessagesUserContentBlock, AnthropicMessagesToolResultBlock>,
  at: MessagePosition,
): IRInputUserContentPart => {
  switch (block.type) {
  case 'text': return { type: 'text', text: block.text };
  case 'image': return { type: 'image', image: imageMedia(block.source) };
  case 'document': return { type: 'document', document: documentFromBlock(block) };
  default: throw new TranslateInputException(`messages.${at.messageIdx}.content.${at.blockIdx}.type: '${(block as { type: string }).type}' content blocks are not supported in user content.`);
  }
};

const toolResultPart = (block: AnthropicMessagesToolResultBlock['content']): IRInputToolResultContentPart[] => {
  if (block === undefined) return [];
  if (typeof block === 'string') return [{ type: 'text', text: block }];
  const parts: IRInputToolResultContentPart[] = [];
  const searchResults: AnthropicMessagesSearchResultBlock[] = [];
  // Only consecutive search results share an array, so text and images retain
  // their positions while an all-search result still becomes one JSON value.
  const flushSearchResults = (): void => {
    if (searchResults.length === 0) return;
    parts.push({ type: 'text', text: JSON.stringify(searchResults) });
    searchResults.length = 0;
  };
  for (const part of block) {
    if (part.type === 'search_result') {
      searchResults.push(part);
      continue;
    }
    flushSearchResults();
    if (part.type === 'text') parts.push({ type: 'text', text: part.text });
    else if (part.type === 'image') parts.push({ type: 'image', image: imageMedia(part.source) });
    else if (part.type === 'document') parts.push({ type: 'document', document: documentFromBlock(part) });
    else parts.push({ type: 'text', text: JSON.stringify(part) });
  }
  flushSearchResults();
  return parts;
};

const clientItems = (
  message: Exclude<AnthropicMessagesMessage, { role: 'assistant' }>,
  messageIdx: number,
): IRInputClientItem[] => {
  if (message.role === 'system') {
    if (typeof message.content !== 'string' && message.content.some(block => block.type !== 'text')) {
      throw new TranslateInputException('Only text system content is supported.');
    }
    return [{ type: 'message', role: 'system', content: textPartsToIR(message.content as string | readonly AnthropicMessagesTextBlockParam[]) }];
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
    pending.push(userContentPart(block, { messageIdx, blockIdx }));
  }
  flush();
  return items;
};

// Server tools return results inside assistant content. Lower each call/result round into assistant and client turns to preserve source order.
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
type ServerToolResultBlock = Extract<AnthropicMessagesAssistantInputContentBlock, {
  type: 'web_search_tool_result' | 'web_fetch_tool_result' | 'code_execution_tool_result'
  | 'bash_code_execution_tool_result' | 'text_editor_code_execution_tool_result' | 'tool_search_tool_result';
}>;
const SERVER_TOOL_RESULT_TYPES: ReadonlySet<AnthropicMessagesAssistantInputContentBlock['type']> = new Set([
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'tool_search_tool_result',
]);

const isServerToolResult = (block: AnthropicMessagesAssistantInputContentBlock): block is ServerToolResultBlock =>
  SERVER_TOOL_RESULT_TYPES.has(block.type);

interface AnthropicMessagesAssistantSegments {
  // Each run of assistant items is followed by the server results it produced, preserving their source order.
  readonly segments: readonly {
    readonly assistant: readonly IRInputAssistantItem[];
    readonly serverResults: readonly IRInputClientItem[];
  }[];
}

const assistantSegments = (message: Extract<AnthropicMessagesMessage, { role: 'assistant' }>, messageIdx: number): AnthropicMessagesAssistantSegments => {
  if (typeof message.content === 'string') {
    // An explicitly empty assistant message still occupies a turn of its own;
    // dropping it would let two client turns merge across where it stood.
    return { segments: [{ assistant: [{ type: 'message', content: [{ type: 'text', text: message.content }] }], serverResults: [] }] };
  }

  const segments: { assistant: IRInputAssistantItem[]; serverResults: IRInputClientItem[] }[] = [];
  let assistant: IRInputAssistantItem[] = [];
  let serverResults: IRInputClientItem[] = [];
  const pending: IRInputAssistantContentPart[] = [];
  const flushText = (): void => {
    if (pending.length === 0) return;
    assistant.push({ type: 'message', content: [...pending] });
    pending.length = 0;
  };
  // A result closes the run it answers, so the pair becomes one segment.
  const flushSegment = (): void => {
    flushText();
    if (assistant.length === 0 && serverResults.length === 0) return;
    segments.push({ assistant, serverResults });
    assistant = [];
    serverResults = [];
  };

  for (const [blockIdx, block] of message.content.entries()) {
    if (isServerToolResult(block)) {
      flushText();
      const result = block;
      serverResults.push({
        type: 'tool_result',
        call_id: result.tool_use_id,
        output: JSON.stringify(result.content),
        ...(typeof result.content === 'object' && result.content !== null && !Array.isArray(result.content)
          && 'type' in result.content && typeof result.content.type === 'string' && result.content.type.endsWith('_error')
          ? { is_error: true }
          : {}),
      });
      flushSegment();
      continue;
    }
    switch (block.type) {
    case 'text':
      pending.push({ type: 'text', text: block.text });
      break;
    case 'thinking':
      flushText();
      if (block.thinking !== '') assistant.push({ type: 'reasoning', summary: [block.thinking] });
      break;
    case 'redacted_thinking':
      // Opaque redacted thinking has no translatable input-IR representation.
      break;
    // A client tool and a server tool are the same fact to every target: a call
    // the rest of the conversation answers. Only the client answers a client
    // call, which is what the next real user turn carries.
    case 'tool_use':
    case 'server_tool_use':
      flushText();
      assistant.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
      break;

    default:
      throw new TranslateInputException(`messages.${messageIdx}.content.${blockIdx}.type: '${(block as { type: string }).type}' assistant content blocks are not supported on this model`);
    }
  }
  flushSegment();
  return { segments };
};

const anthropicMessagesSystemToIR = (system: AnthropicMessagesPayload['system']): IRInputTurn | undefined => {
  if (system === undefined) return undefined;
  const content = textPartsToIR(system);
  return content.length === 0 ? undefined : { kind: 'client', items: [{ type: 'instruction', content }] };
};

const anthropicMessagesTurnToIR = (
  turn: AnthropicMessagesConversationTurn,
  firstMessageIndex = 0,
): IRInputTurn[] => {
  if (turn.role === 'assistant') {
    const turns: IRInputTurn[] = [];
    for (const [index, message] of turn.items.entries()) {
      for (const segment of assistantSegments(message, firstMessageIndex + index).segments) {
        // The pair a server tool states is one call and the result written into
        // the same message, so the result becomes the client turn that answers
        // it before the next run of assistant content begins.
        if (segment.assistant.length > 0) turns.push({ kind: 'assistant', items: segment.assistant });
        if (segment.serverResults.length > 0) turns.push({ kind: 'client', items: segment.serverResults });
      }
    }
    return turns;
  }
  return [{
    kind: 'client',
    items: turn.items.flatMap((message, index) => {
      if (message.role !== 'user' && message.role !== 'system') {
        throw new TranslateInputException(`messages.${firstMessageIndex + index}.role: role '${(message as { role: string }).role}' is not supported on this model`);
      }
      return clientItems(message, firstMessageIndex + index);
    }),
  }];
};

// Both Messages client-tool declaration forms carry JSON Schema, so they use the function-tool IR arm.
const toolToIR = (tool: AnthropicMessagesClientTool): IRInputTool => {
  return {
    type: 'function',
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    parameters: klona(tool.input_schema),
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
    const name = choice.name;
    if (!declarations.some(tool => tool.name === name)) {
      throw new TranslateInputException(`Anthropic Messages tool_choice names an undeclared tool: ${String(name)}`);
    }
    return { type: 'function', name };
  }
  }
};

const anthropicMessagesToolsToIR = (payload: AnthropicMessagesPayload): Pick<IRInputRequestHeader, 'tools' | 'tool_choice'> => {
  // A hosted declaration runs on the vendor's own infrastructure and has no
  // meaning in another protocol, so only the callable arms are read.
  const declarations = (payload.tools ?? [])
    .filter((tool): tool is AnthropicMessagesClientTool => tool.type === undefined || tool.type === 'custom')
    .map(toolToIR);
  // A selector is validated against the declarations either way: dropping one
  // that names nothing would widen what the model may call.
  const toolChoice = payload.tool_choice == null ? undefined : toolChoiceToIR(payload.tool_choice, declarations);
  return {
    ...(declarations.length === 0 ? {} : { tools: declarations }),
    ...(toolChoice === undefined || declarations.length === 0 && toolChoice === 'required' ? {} : { tool_choice: toolChoice }),
  };
};

const anthropicMessagesSettingsToIR = (payload: AnthropicMessagesPayload): IRInputSettings => {
  const format = payload.output_config?.format;
  // Messages schemas are strict. We assign a stable name because the source format has none.
  // https://platform.claude.com/docs/en/build-with-claude/structured-outputs
  const outputFormat: IRInputOutputFormat | undefined = format?.type === 'json_schema'
    ? { type: 'json_schema', name: 'messages_response', schema: klona(format.schema), strict: true }
    : undefined;

  const reasoningEffort = reasoningEffortToIR(payload);
  const serviceTier = serviceTierToIR(payload);
  const metadata = metadataToIR(payload.metadata);
  return {
    model: payload.model,
    stream: payload.stream === true,
    ...(payload.temperature == null ? {} : { temperature: payload.temperature }),
    ...(payload.top_p == null ? {} : { top_p: payload.top_p }),
    ...(payload.top_k == null ? {} : { top_k: payload.top_k }),
    ...(payload.stop_sequences == null ? {} : { stop: [...payload.stop_sequences] }),
    ...(payload.max_tokens == null ? {} : { max_output_tokens: payload.max_tokens }),
    ...(outputFormat === undefined ? {} : { output_format: outputFormat }),
    ...(serviceTier === undefined ? {} : { service_tier: serviceTier }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(payload.tool_choice !== undefined && 'disable_parallel_tool_use' in payload.tool_choice && payload.tool_choice.disable_parallel_tool_use != null
      ? { parallel_tool_calls: !payload.tool_choice.disable_parallel_tool_use }
      : {}),
    ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
    ...(payload.thinking?.type === 'enabled' ? { reasoning_budget: payload.thinking.budget_tokens } : {}),
    ...(payload.thinking?.type === 'adaptive' ? { reasoning_budget_dynamic: true } : {}),
  };
};

// Our metadata input extension is normalized to string values; null-valued entries are omitted and non-string values fail here.
const metadataToIR = (metadata: AnthropicMessagesMetadataEx | undefined): Record<string, string> | undefined => {
  if (metadata === undefined) return undefined;
  const entries = Object.entries(metadata).flatMap(([key, value]): [string, string][] => {
    if (value == null) return [];
    if (typeof value !== 'string') throw new TranslateInputException(`Cannot translate Anthropic Messages metadata field '${key}' to a string metadata value.`);
    return [[key, value]];
  });
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
};

// Messages speed takes precedence over service_tier when projecting onto the shared tier field.
// https://docs.claude.com/en/build-with-claude/fast-mode
const serviceTierToIR = (payload: AnthropicMessagesPayload): string | undefined => {
  if (payload.speed === 'fast') return FAST_SERVICE_TIER;

  if (payload.speed === 'standard') return undefined;
  return payload.service_tier ?? undefined;
};

// A level stated outright wins over the one a thinking mode implies, because the
// caller wrote it explicitly while the mode only bounds it.
const reasoningEffortToIR = (payload: AnthropicMessagesPayload): string | undefined => {
  if (payload.output_config?.effort != null) return payload.output_config.effort;
  if (payload.thinking?.type === 'disabled') return 'none';
  if (payload.thinking?.type === 'adaptive') return 'medium';
  return undefined;
};

/**
 * A Messages request read into the turns a writer consumes.
 *
 * Messages states its instruction in a top-level field and its conversation in
 * `messages`; both enter the IR, and the request-wide fields come from the same
 * payload.
 *
 * A server tool's result sits inside the assistant message that called it, and
 * an assistant turn can therefore yield both assistant and client turns. The
 * lazy conversion preserves those boundaries until composition resolves the
 * sidecar path and joins adjacent client turns.
 */
export const readAnthropicMessagesRequest = (payload: AnthropicMessagesPayload): SourceReading<AnthropicMessagesSourceAssistantTurn> => {
  const request: IRInputRequestHeader = {
    settings: anthropicMessagesSettingsToIR(payload),
    ...anthropicMessagesToolsToIR(payload),
  };

  const turns: SourceTurnSlot<AnthropicMessagesSourceAssistantTurn>[] = [];
  let messageIndex = 0;

  const instruction = anthropicMessagesSystemToIR(payload.system);
  if (instruction !== undefined) turns.push({ kind: 'client', toIRInputTurns: () => [instruction] });

  for (const turn of partitionAnthropicMessagesTurns(payload.messages)) {
    const firstMessageIndex = messageIndex;
    messageIndex += turn.items.length;
    if (turn.role === 'assistant') {
      turns.push({
        kind: 'assistant',
        assistantTurn: turn.items,
        toIRInputTurns: () => anthropicMessagesTurnToIR(turn, firstMessageIndex),
      });
      continue;
    }
    turns.push({ kind: 'client', toIRInputTurns: () => anthropicMessagesTurnToIR(turn, firstMessageIndex) });
  }

  return { request, turns };
};
