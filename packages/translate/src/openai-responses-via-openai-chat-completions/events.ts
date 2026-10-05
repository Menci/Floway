import { createChatStreamLifecycle, type ChatStreamLifecycleEvent, type ChatStreamSegment } from '../shared/openai-chat-completions/lifecycle.ts';
import { unwrapCustomToolInput } from '../shared/openai-responses-via/custom-tool-wrap.ts';
import * as openaiResponses from '../shared/openai-responses-via/openai-responses-event-builder.ts';
import { eventFrame, splitInclusiveInputTokens, type ProtocolFrame } from '@floway-dev/protocols/common';
import { OpenAIChatCompletionsAssistantMessagePrivate, accumulateOpenAIChatCompletionsPrivate, finalizeOpenAIChatCompletionsPrivate, type OpenAIChatCompletionsPrivateDraft, type OpenAIChatCompletionsAssistantDelta, type OpenAIChatCompletionsUsageEx, type OpenAIChatCompletionsPrivateContext, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { createRandomOpenAIResponsesItemId, type OpenAIResponsesOutputItemEx, type OpenAIResponsesOutputReasoning, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

const mapOpenAIChatCompletionsUsageToOpenAIResponsesUsage = (usage: OpenAIChatCompletionsStreamEvent['usage']): NonNullable<OpenAIResponsesResultEx['usage']> | undefined => {
  if (!usage) return undefined;
  const cachedTokens = (usage as OpenAIChatCompletionsUsageEx).prompt_tokens_details?.cached_tokens;
  const cacheWriteTokens = (usage as OpenAIChatCompletionsUsageEx).prompt_tokens_details?.cache_creation_input_tokens
    ?? (usage as OpenAIChatCompletionsUsageEx).prompt_tokens_details?.cache_write_tokens;
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
  // Validated, not consumed. OpenAI Responses names the same three input buckets
  // OpenAI Chat Completions does, so the counts cross unchanged and there is nothing
  // to recompute — but this package is the one asserting that what it emits
  // satisfies the inclusive contract its own output type declares, rather than
  // relying on whoever happens to read the usage next.
  splitInclusiveInputTokens(usage.prompt_tokens, cachedTokens, cacheWriteTokens);
  return {
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    ...(cachedTokens !== undefined || cacheWriteTokens !== undefined
      ? {
          input_tokens_details: {
            cached_tokens: cachedTokens ?? 0,
            ...(cacheWriteTokens !== undefined ? { cache_write_tokens: cacheWriteTokens } : {}),
          },
        }
      : {}),
    // OpenAI Chat Completions' `reasoning_tokens` and OpenAI Responses' `reasoning_tokens`
    // are the same quantity, so an upstream that reports one is translated
    // rather than dropped. OpenAI's schema makes the breakdown mandatory, but
    // a translator's output is interior — a zero synthesized here would be
    // indistinguishable from a zero an upstream measured — so absence stays
    // absence, exactly as for the input breakdown above.
    // https://github.com/openai/openai-python/blob/f16fbbd2bd25dc1ff150b5f78dbd15ff6bab6d91/src/openai/types/openaiResponses/response_usage.py#L21-L47
    ...(reasoningTokens === undefined ? {} : { output_tokens_details: { reasoning_tokens: reasoningTokens } }),
  };
};

interface StreamItem {
  id: string;
  text: string;
  callId?: string;
  name?: string;
  custom: boolean;
}

interface OpenAIChatCompletionsToOpenAIResponsesStreamState {
  responseCreated: boolean;
  sequenceNumber: number;
  responseId: string;
  model: string;
  completedItems: (OpenAIResponsesOutputItemEx | undefined)[];
  items: Map<number, StreamItem>;
  lifecycle: ReturnType<typeof createChatStreamLifecycle>;
  privateState: OpenAIChatCompletionsPrivateDraft;
  usage?: NonNullable<OpenAIResponsesResultEx['usage']>;
  serviceTier?: OpenAIResponsesResultEx['service_tier'];
  pendingFinishReason?: OpenAIChatCompletionsStreamEvent['choices'][0]['finish_reason'];
  completed: boolean;
  customToolNames: ReadonlySet<string>;
}

export const createOpenAIChatCompletionsToOpenAIResponsesStreamState = (customToolNames: ReadonlySet<string> = new Set()): OpenAIChatCompletionsToOpenAIResponsesStreamState => ({
  responseCreated: false, sequenceNumber: 0, responseId: '', model: '', completedItems: [], items: new Map(),
  lifecycle: createChatStreamLifecycle(index => console.warn(`Ignoring data for closed Chat tool call ${index}`)),
  completed: false, customToolNames, privateState: {},
});

const buildResult = (state: OpenAIChatCompletionsToOpenAIResponsesStreamState, status: OpenAIResponsesResultEx['status']): OpenAIResponsesResultEx => openaiResponses.result({
  id: state.responseId, model: state.model,
  output: state.completedItems.filter((item): item is OpenAIResponsesOutputItemEx => item !== undefined),
  status,
  ...(status === 'incomplete' ? { incompleteDetails: { reason: 'max_output_tokens' as const } } : {}),
  ...(state.usage !== undefined ? { usage: state.usage } : {}),
  ...(state.serviceTier !== undefined ? { serviceTier: state.serviceTier } : {}),
});

const reasoningItem = (id: string, text: string): OpenAIResponsesOutputReasoning => ({ type: 'reasoning', id, summary: [], content: [{ type: 'reasoning_text', text }] });

const lifecycleEvents = (changes: ChatStreamLifecycleEvent[], state: OpenAIChatCompletionsToOpenAIResponsesStreamState): OpenAIResponsesStreamEventEx[] => {
  const events: OpenAIResponsesStreamEventEx[] = [];
  for (const change of changes) {
    const { slot } = change;
    if (change.type === 'open') {
      const custom = change.name !== undefined && state.customToolNames.has(change.name);
      const id = createRandomOpenAIResponsesItemId(slot.kind === 'tool' ? (custom ? 'custom_tool_call' : 'function_call') : slot.kind === 'reasoning' ? 'reasoning' : 'message');
      const item: StreamItem = { id, text: '', callId: change.id, name: change.name, custom };
      state.items.set(slot.index, item);
      if (slot.kind === 'reasoning') {
        events.push(...openaiResponses.seq(state, [
          { type: 'response.output_item.added', output_index: slot.index, item: reasoningItem(id, '') },
          { type: 'response.content_part.added', item_id: id, output_index: slot.index, content_index: 0, part: { type: 'reasoning_text', text: '' } },
        ]));
      } else if (slot.kind === 'text') events.push(...openaiResponses.textStart(state, slot.index, id));
      else if (slot.kind === 'refusal') events.push(...openaiResponses.refusalStart(state, slot.index, id));
      else events.push(...openaiResponses.itemAdded(state, slot.index, custom
        ? openaiResponses.customToolCallItem(id, change.id!, change.name!, '')
        : openaiResponses.functionCallItem(id, change.id!, change.name!, '', 'in_progress')));
      continue;
    }
    const current = state.items.get(slot.index)!;
    if (change.type === 'delta') {
      current.text += change.text;
      if (slot.kind === 'reasoning') events.push(...openaiResponses.seq(state, [{ type: 'response.reasoning_text.delta', item_id: current.id, output_index: slot.index, content_index: 0, delta: change.text }]));
      else if (slot.kind === 'text') {
        events.push(...openaiResponses.textDelta(state, slot.index, current.id, change.text));
      } else if (slot.kind === 'refusal') {
        if (change.text) events.push(...openaiResponses.refusalDelta(state, slot.index, current.id, change.text));
      } else if (!current.custom) events.push(...openaiResponses.argumentsDelta(state, slot.index, current.id, change.text));
      continue;
    }
    let item: OpenAIResponsesOutputItemEx;
    if (slot.kind === 'reasoning') {
      item = reasoningItem(current.id, current.text);
      events.push(...openaiResponses.seq(state, [
        { type: 'response.reasoning_text.done', item_id: current.id, output_index: slot.index, content_index: 0, text: current.text },
        { type: 'response.content_part.done', item_id: current.id, output_index: slot.index, content_index: 0, part: { type: 'reasoning_text', text: current.text } },
        { type: 'response.output_item.done', output_index: slot.index, item },
      ]));
    } else if (slot.kind === 'text') {
      const part = openaiResponses.textPart(current.text, []);
      item = openaiResponses.messageItem(current.id, 'completed', part);
      events.push(...openaiResponses.textDone(state, slot.index, current.id, part, item));
    } else if (slot.kind === 'refusal') {
      const part = openaiResponses.refusalPart(current.text);
      item = openaiResponses.messageItem(current.id, 'completed', part);
      events.push(...openaiResponses.refusalDone(state, slot.index, current.id, part, item));
    } else if (current.custom) {
      // Wrapped custom arguments become freeform input only after the JSON object is complete.
      const input = unwrapCustomToolInput(current.text);
      item = openaiResponses.customToolCallItem(current.id, current.callId!, current.name!, input);
      events.push(...openaiResponses.customToolCallDone(state, slot.index, current.id, input, item));
    } else {
      item = openaiResponses.functionCallItem(current.id, current.callId!, current.name!, current.text, 'completed');
      events.push(...openaiResponses.functionCallDone(state, slot.index, current.id, current.text, item));
    }
    state.completedItems[slot.index] = item;
  }
  return events;
};

export const translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents = (chunk: OpenAIChatCompletionsStreamEvent, state: OpenAIChatCompletionsToOpenAIResponsesStreamState): OpenAIResponsesStreamEventEx[] => {
  const events: OpenAIResponsesStreamEventEx[] = [];
  state.responseId = chunk.id;
  state.model = chunk.model;
  if (chunk.service_tier !== undefined) state.serviceTier = chunk.service_tier;
  if (chunk.usage !== undefined) state.usage = mapOpenAIChatCompletionsUsageToOpenAIResponsesUsage(chunk.usage);
  if (!state.responseCreated) {
    state.responseCreated = true;
    events.push(...openaiResponses.started(state, buildResult(state, 'in_progress')));
  }
  for (const choice of chunk.choices) {
    const { delta } = choice;
    const privateDelta = (delta as OpenAIChatCompletionsAssistantDelta)[OpenAIChatCompletionsAssistantMessagePrivate];
    const segments: ChatStreamSegment[] = [];
    if (privateDelta !== undefined) {
      accumulateOpenAIChatCompletionsPrivate(state.privateState, privateDelta);
      if (privateDelta.reasoningText !== undefined) segments.push({ kind: 'reasoning', text: privateDelta.reasoningText });
    }
    if (typeof delta.content === 'string') segments.push({ kind: 'text', text: delta.content });
    if (delta.refusal != null) segments.push({ kind: 'refusal', text: delta.refusal });
    for (const call of delta.tool_calls ?? []) segments.push({ kind: 'tool', index: call.index, id: call.id, name: call.function?.name, arguments: call.function?.arguments });
    events.push(...lifecycleEvents(state.lifecycle.accept(segments), state));
    if (choice.finish_reason != null) state.pendingFinishReason = choice.finish_reason;
  }
  return events;
};

export const flushOpenAIChatCompletionsToOpenAIResponsesEvents = (state: OpenAIChatCompletionsToOpenAIResponsesStreamState): OpenAIResponsesStreamEventEx[] => {
  if (state.completed || !state.responseCreated) return [];
  const events = lifecycleEvents(state.lifecycle.finish(), state);
  state.completed = true;
  return [...events, ...openaiResponses.terminal(state, buildResult(state, state.pendingFinishReason === 'length' ? 'incomplete' : 'completed'))];
};

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  customToolNames: ReadonlySet<string> = new Set(),
  context: OpenAIChatCompletionsPrivateContext,
): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEventEx>> {
  const state = createOpenAIChatCompletionsToOpenAIResponsesStreamState(customToolNames);
  for await (const frame of frames) {
    if (frame.type === 'done') break;
    for (const event of translateOpenAIChatCompletionsChunkToOpenAIResponsesEvents(frame.event, state)) yield eventFrame(event);
  }
  if (!state.responseCreated) throw new Error('Upstream Chat Completions stream contained no completion chunks.');
  const privateState = finalizeOpenAIChatCompletionsPrivate(state.privateState);
  const encrypted = await context.codec.encapsulate({ sidecar: privateState?.sidecar ?? { upstreamProtocol: 'openaiChatCompletions' } });
  for (const event of lifecycleEvents(state.lifecycle.finish(), state)) yield eventFrame(event);
  const index = state.items.size;
  const item = openaiResponses.reasoningItem(createRandomOpenAIResponsesItemId('reasoning'), '', encrypted);
  state.completedItems[index] = item;
  for (const event of openaiResponses.completedReasoning(state, index, item)) yield eventFrame(event);
  for (const event of flushOpenAIChatCompletionsToOpenAIResponsesEvents(state)) yield eventFrame(event);
};
