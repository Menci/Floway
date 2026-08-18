import { unwrapCustomToolInput } from '../shared/openai-responses-via/custom-tool-wrap.ts';
import * as openaiResponses from '../shared/openai-responses-via/openai-responses-event-builder.ts';
import { anthropicMessagesRefusalOpenAIResponsesError } from '../shared/via-anthropic-messages/refusal.ts';
import { openAIServiceTierFromAnthropicMessagesUsage } from '../shared/via-anthropic-messages/service-tier.ts';
import { inclusiveAnthropicMessagesInputUsage } from '../shared/via-anthropic-messages/usage.ts';
import {
  mergeAnthropicMessagesUsageSnapshot,
  anthropicMessagesUsageSnapshot,
} from '@floway-dev/protocols/anthropic-messages';
import type {
  AnthropicMessagesContentBlockDeltaEvent,
  AnthropicMessagesContentBlockStartEvent,
  AnthropicMessagesContentBlockStopEvent,
  AnthropicMessagesMessageDeltaEvent,
  AnthropicMessagesMessageStartEvent,
  AnthropicMessagesRefusalStopDetails,
  AnthropicMessagesStreamEvent,
  AnthropicMessagesTextCitation,
  AnthropicMessagesUsageSnapshot,
} from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { createRandomOpenAIResponsesItemId, type OpenAIResponsesAnnotation, type OpenAIResponsesOutputItem, type OpenAIResponsesResult, type OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

const UPSTREAM_ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE = 'Upstream Anthropic Messages stream ended without a message_stop event.';

const upstreamAnthropicMessagesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEvent>>): AsyncGenerator<AnthropicMessagesStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;

    yield frame.event;
    if (frame.event.type === 'message_stop' || frame.event.type === 'error') {
      return;
    }
  }

  throw new Error(UPSTREAM_ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE);
};

type OutputBlockInfo =
  | {
    type: 'thinking';
    outputIndex: number;
    itemId: string;
    thinkingText: string;
    // Genuine upstream reasoning signature, captured from `signature_delta`.
    // Carried verbatim as the OpenAI Responses item's `encrypted_content` so it
    // round-trips back to the Anthropic Messages upstream's next-turn validation.
    encryptedContent?: string;
  }
  | {
    type: 'text';
    outputIndex: number;
    itemId: string;
    blockText: string;
    // Citations accumulated in emission order, then carried on the completed
    // content part. `annotation_index` is scoped to one content part and
    // OpenAI Responses targets always use content_index=0 for our single-part
    // assistant message, so this array's length at push time is that index.
    annotations: OpenAIResponsesAnnotation[];
  }
  | {
    type: 'tool_use';
    outputIndex: number;
    itemId: string;
    toolCallId: string;
    toolName: string;
    toolNamespace?: string;
    toolArguments: string;
  }
  | {
    type: 'custom_tool_use';
    outputIndex: number;
    itemId: string;
    toolCallId: string;
    toolName: string;
    wrappedArguments: string;
  };

interface AnthropicMessagesToOpenAIResponsesStreamState {
  responseId: string;
  model: string;
  outputIndex: number;
  sequenceNumber: number;
  blockMap: Map<number, OutputBlockInfo>;
  accumulatedText: string;
  completedItems: OpenAIResponsesOutputItem[];
  usage: AnthropicMessagesUsageSnapshot;
  stopReason?: AnthropicMessagesMessageDeltaEvent['delta']['stop_reason'];
  stopDetails?: AnthropicMessagesRefusalStopDetails | null;
  customToolNames: ReadonlySet<string>;
  namespaceTargetToSource: ReadonlyMap<string, { namespace: string; name: string }>;
}

const buildResult = (state: AnthropicMessagesToOpenAIResponsesStreamState, status: OpenAIResponsesResult['status']): OpenAIResponsesResult => {
  const { cacheWrite, cacheWrite1h, inclusiveInput: inputTokens } = inclusiveAnthropicMessagesInputUsage(state.usage);
  const cacheCreation = cacheWrite + cacheWrite1h;
  const hasCacheCreation = state.usage.cache_creation_input_tokens !== undefined
    || state.usage.cache_creation?.ephemeral_5m_input_tokens !== undefined
    || state.usage.cache_creation?.ephemeral_1h_input_tokens !== undefined;
  const thinkingTokens = state.usage.output_tokens_details?.thinking_tokens;
  const serviceTier = openAIServiceTierFromAnthropicMessagesUsage(state.usage);

  return openaiResponses.result({
    id: state.responseId,
    model: state.model,
    output: state.completedItems,
    outputText: state.accumulatedText,
    status,
    // Anthropic Messages signals "ran out of tokens" with `stop_reason: 'max_tokens'`,
    // which the caller maps to `status === 'incomplete'` (see
    // `handleMessageStop` in this file). Other Anthropic stop_reasons
    // don't map to incomplete.
    ...(status === 'incomplete' ? { incompleteDetails: { reason: 'max_output_tokens' as const } } : {}),
    usage: {
      input_tokens: inputTokens,
      output_tokens: state.usage.output_tokens,
      total_tokens: inputTokens + state.usage.output_tokens,
      ...(state.usage.cache_read_input_tokens !== undefined || hasCacheCreation
        ? {
            input_tokens_details: {
              cached_tokens: state.usage.cache_read_input_tokens ?? 0,
              ...(hasCacheCreation ? { cache_write_tokens: cacheCreation } : {}),
            },
          }
        : {}),
      // Anthropic's `thinking_tokens` and OpenAI Responses' `reasoning_tokens` are the
      // same quantity: the reasoning share of the inclusive output-token total.
      // As with the input breakdown above, an upstream that reports none is
      // translated to absence rather than to a synthesized zero.
      // https://github.com/openai/openai-python/blob/f16fbbd2bd25dc1ff150b5f78dbd15ff6bab6d91/src/openai/types/openaiResponses/response_usage.py#L21-L47
      ...(thinkingTokens === undefined ? {} : { output_tokens_details: { reasoning_tokens: thinkingTokens } }),
    },
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    ...(status === 'failed' ? { error: anthropicMessagesRefusalOpenAIResponsesError(state.stopDetails) } : {}),
  });
};

const handleMessageStart = (event: AnthropicMessagesMessageStartEvent, state: AnthropicMessagesToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  state.model = event.message.model;
  state.usage = anthropicMessagesUsageSnapshot(event.message.usage);

  const response = buildResult(state, 'in_progress');

  return openaiResponses.started(state, response);
};

const handleContentBlockStart = (event: AnthropicMessagesContentBlockStartEvent, state: AnthropicMessagesToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  switch (event.content_block.type) {
  case 'thinking': {
    const outputIndex = state.outputIndex++;
    const itemId = createRandomOpenAIResponsesItemId('reasoning');
    state.blockMap.set(event.index, {
      type: 'thinking',
      outputIndex,
      itemId,
      thinkingText: '',
    });

    return openaiResponses.reasoningStart(state, outputIndex, itemId);
  }
  case 'redacted_thinking': {
    // A redacted upstream reasoning block carries an opaque signature in
    // `data` and no readable text. Surface it as a OpenAI Responses reasoning item
    // whose `encrypted_content` round-trips that opaque blob.
    const outputIndex = state.outputIndex++;
    const itemId = createRandomOpenAIResponsesItemId('reasoning');
    state.blockMap.set(event.index, {
      type: 'thinking',
      outputIndex,
      itemId,
      thinkingText: '',
      encryptedContent: event.content_block.data,
    });

    return openaiResponses.reasoningStart(state, outputIndex, itemId);
  }
  case 'text': {
    const outputIndex = state.outputIndex++;
    const itemId = createRandomOpenAIResponsesItemId('message');
    state.blockMap.set(event.index, {
      type: 'text',
      outputIndex,
      itemId,
      blockText: '',
      annotations: [],
    });

    return openaiResponses.textStart(state, outputIndex, itemId);
  }
  case 'tool_use': {
    const outputIndex = state.outputIndex++;
    if (state.customToolNames.has(event.content_block.name)) {
      const itemId = createRandomOpenAIResponsesItemId('custom_tool_call');
      state.blockMap.set(event.index, {
        type: 'custom_tool_use',
        outputIndex,
        itemId,
        toolCallId: event.content_block.id,
        toolName: event.content_block.name,
        wrappedArguments: '',
      });

      return openaiResponses.itemAdded(state, outputIndex, openaiResponses.customToolCallItem(itemId, event.content_block.id, event.content_block.name, ''));
    }

    const itemId = createRandomOpenAIResponsesItemId('function_call');
    const sourceTool = state.namespaceTargetToSource.get(event.content_block.name);
    const info: OutputBlockInfo = {
      type: 'tool_use',
      outputIndex,
      itemId,
      toolCallId: event.content_block.id,
      toolName: sourceTool?.name ?? event.content_block.name,
      ...(sourceTool !== undefined ? { toolNamespace: sourceTool.namespace } : {}),
      toolArguments: '',
    };
    state.blockMap.set(event.index, info);

    return openaiResponses.itemAdded(state, outputIndex, openaiResponses.functionCallItem(info.itemId, info.toolCallId, info.toolName, info.toolArguments, 'in_progress', info.toolNamespace));
  }
  case 'fallback':
    state.model = event.content_block.to.model;
    return [];
  default:
    return [];
  }
};

// Anthropic emits `citations_delta` against a text content block when the
// model cites a structured `search_result` / `web_search_result` tool
// result. We surface these as OpenAI Responses
// `response.output_text.annotation.added` events with inline
// `url_citation` annotations.
//
// Offset approximation: Anthropic gives `start_block_index` /
// `end_block_index` referring to indices inside our
// `AnthropicMessagesSearchResultBlock.content` (the cited source's text, not the
// model's reply). OpenAI Responses url_citation indices are character offsets
// inside the model's reply. We approximate using cited_text length:
// `end_index = blockText.length` (running char count emitted so far on
// this content part), `start_index = max(0, end_index - cited_text.length)`.
// Citation deltas without `cited_text` are dropped — we have no way to
// anchor them. The openai-chat-completions-via-anthropic-messages translator
// blanket-drops every `citations_delta` because OpenAI Chat Completions has no
// url_citation equivalent.
const handleTextCitation = (info: Extract<OutputBlockInfo, { type: 'text' }>, citation: AnthropicMessagesTextCitation, state: AnthropicMessagesToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  // Future citation variants (`char_location`, `page_location`,
  // `content_block_location` from Anthropic native long-document
  // citations) are not in the current `AnthropicMessagesTextCitation` union; if
  // they're added, this branch needs to either skip or map them.
  if (citation.type !== 'search_result_location' && citation.type !== 'web_search_result_location') {
    return [];
  }

  if (!citation.cited_text) {
    // A present cited_text on an empty blockText (citation arriving
    // BEFORE any text_delta on this block) yields end_index=0,
    // start_index=0; in practice Anthropic emits citation deltas after
    // the triggering text chunk so this corner is unreachable.
    return [];
  }

  const endIndex = info.blockText.length;
  const startIndex = Math.max(0, endIndex - citation.cited_text.length);
  const annotationIndex = info.annotations.length;
  const annotation: OpenAIResponsesAnnotation = {
    type: 'url_citation',
    url: citation.url,
    title: citation.title,
    start_index: startIndex,
    end_index: endIndex,
  };

  info.annotations.push(annotation);

  return openaiResponses.seq(state, [
    {
      type: 'response.output_text.annotation.added',
      output_index: info.outputIndex,
      content_index: 0,
      item_id: info.itemId,
      annotation_index: annotationIndex,
      annotation,
    },
  ]);
};

const handleContentBlockDelta = (event: AnthropicMessagesContentBlockDeltaEvent, state: AnthropicMessagesToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  const info = state.blockMap.get(event.index);
  if (!info) return [];

  switch (info.type) {
  case 'thinking':
    if (event.delta.type === 'thinking_delta') {
      info.thinkingText += event.delta.thinking;
      return openaiResponses.reasoningDelta(state, info.outputIndex, info.itemId, event.delta.thinking);
    }
    if (event.delta.type === 'signature_delta') {
      // The upstream owns this signature; carry it verbatim as the OpenAI Responses
      // item's `encrypted_content` (no gateway envelope) so the next turn's
      // upstream validation still passes.
      info.encryptedContent = event.delta.signature;
    }
    return [];
  case 'text':
    if (event.delta.type === 'citations_delta') {
      return handleTextCitation(info, event.delta.citation, state);
    }
    if (event.delta.type !== 'text_delta') return [];
    info.blockText += event.delta.text;
    state.accumulatedText += event.delta.text;
    return openaiResponses.textDelta(state, info.outputIndex, info.itemId, event.delta.text);
  case 'tool_use':
    if (event.delta.type !== 'input_json_delta') return [];
    info.toolArguments += event.delta.partial_json;
    return openaiResponses.argumentsDelta(state, info.outputIndex, info.itemId, event.delta.partial_json);
  case 'custom_tool_use':
    // Buffer the wrapped JSON argument blob without emitting a delta; we need
    // the complete value to extract the freeform `input` field at stop time.
    if (event.delta.type === 'input_json_delta') {
      info.wrappedArguments += event.delta.partial_json;
    }
    return [];
  }
};

const handleContentBlockStop = (event: AnthropicMessagesContentBlockStopEvent, state: AnthropicMessagesToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  const info = state.blockMap.get(event.index);
  if (!info) return [];

  state.blockMap.delete(event.index);

  if (info.type === 'thinking') {
    const summaryText = info.thinkingText;
    const itemId = info.itemId;
    const item = openaiResponses.reasoningItem(itemId, summaryText, info.encryptedContent);

    state.completedItems.push(item);

    return openaiResponses.reasoningDone(state, info.outputIndex, itemId, summaryText, item);
  }

  if (info.type === 'text') {
    const part = openaiResponses.textPart(info.blockText, info.annotations);
    const item = openaiResponses.messageItem(info.itemId, 'completed', part);

    state.completedItems.push(item);

    return openaiResponses.textDone(state, info.outputIndex, info.itemId, part, item);
  }

  if (info.type === 'custom_tool_use') {
    const input = unwrapCustomToolInput(info.wrappedArguments);
    const item = openaiResponses.customToolCallItem(info.itemId, info.toolCallId, info.toolName, input);

    state.completedItems.push(item);

    return openaiResponses.customToolCallDone(state, info.outputIndex, info.itemId, input, item);
  }

  const item = openaiResponses.functionCallItem(info.itemId, info.toolCallId, info.toolName, info.toolArguments, 'completed', info.toolNamespace);

  state.completedItems.push(item);

  return openaiResponses.functionCallDone(state, info.outputIndex, info.itemId, info.toolArguments, item);
};

export const createAnthropicMessagesToOpenAIResponsesStreamState = (
  responseId: string,
  model: string,
  customToolNames: ReadonlySet<string> = new Set(),
  namespaceTargetToSource: ReadonlyMap<string, { namespace: string; name: string }> = new Map(),
): AnthropicMessagesToOpenAIResponsesStreamState => ({
  responseId,
  model,
  outputIndex: 0,
  sequenceNumber: 0,
  blockMap: new Map(),
  accumulatedText: '',
  completedItems: [],
  usage: anthropicMessagesUsageSnapshot(),
  customToolNames,
  namespaceTargetToSource,
});

export const translateAnthropicMessagesEventToOpenAIResponsesEvents = (event: AnthropicMessagesStreamEvent, state: AnthropicMessagesToOpenAIResponsesStreamState): OpenAIResponsesStreamEvent[] => {
  switch (event.type) {
  case 'message_start':
    return handleMessageStart(event, state);
  case 'content_block_start':
    return handleContentBlockStart(event, state);
  case 'content_block_delta':
    return handleContentBlockDelta(event, state);
  case 'content_block_stop':
    return handleContentBlockStop(event, state);
  case 'message_delta': {
    if (event.delta.stop_reason !== undefined) {
      state.stopReason = event.delta.stop_reason;
    }
    if (event.delta.stop_details !== undefined) {
      state.stopDetails = event.delta.stop_details;
    }
    if (event.usage) {
      state.usage = mergeAnthropicMessagesUsageSnapshot(state.usage, event.usage);
    }
    return [];
  }
  case 'message_stop': {
    const status: OpenAIResponsesResult['status'] = state.stopReason === 'refusal'
      ? 'failed'
      : state.stopReason === 'max_tokens' ? 'incomplete' : 'completed';
    const response = buildResult(state, status);

    return openaiResponses.terminal(state, response);
  }
  // Anthropic's `ping` is a transport keep-alive with no OpenAI Responses counterpart:
  // every spec event is either a delta event or a state-machine event, and a
  // `ping` is neither.
  // https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L459
  // The rule belongs with the producer rather than at a gateway transport
  // boundary, so that it holds for every consumer of this translation and not
  // only for the transports the gateway happens to serve; the native path
  // likewise drops an upstream `ping` inside `parseOpenAIResponsesStream`. Consuming
  // the event without emitting one also keeps the sequence numbering
  // contiguous, which a boundary filter could not do.
  case 'ping':
    return [];
  case 'error':
    return openaiResponses.seq(state, [
      {
        type: 'error',
        message: event.error.message,
        code: event.error.type,
      },
    ]);
  }
};

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEvent>>,
  responseId: string,
  model: string,
  customToolNames: ReadonlySet<string> = new Set(),
  namespaceTargetToSource: ReadonlyMap<string, { namespace: string; name: string }> = new Map(),
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {
  const state = createAnthropicMessagesToOpenAIResponsesStreamState(responseId, model, customToolNames, namespaceTargetToSource);

  for await (const event of upstreamAnthropicMessagesEventsUntilTerminal(frames)) {
    for (const translated of translateAnthropicMessagesEventToOpenAIResponsesEvents(event, state)) {
      yield eventFrame(translated);
    }
  }
};
