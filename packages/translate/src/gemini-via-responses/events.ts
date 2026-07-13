import { geminiCandidateEvent, parseStrictJsonObject } from '../shared/gemini-via/gemini.ts';
import { billableServiceTier, eventFrame, splitCacheWriteTokens, splitInclusiveInputTokens, splitInclusiveOutputTokens, USAGE_BILLING, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiFinishReason, GeminiPart, GeminiStreamEvent, GeminiUsageMetadata } from '@floway-dev/protocols/gemini';
import type { ResponsesOutputFunctionCall, ResponsesOutputReasoning, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

type ResponsesTerminalEvent = Extract<ResponsesStreamEvent, { type: 'response.completed' } | { type: 'response.incomplete' } | { type: 'response.failed' }>;

// Responses input_tokens already includes input_tokens_details.cached_tokens,
// matching Gemini's inclusive promptTokenCount semantics. Pass both through
// directly — no folding. Contrast with gemini-via-messages, where Anthropic's
// input_tokens excludes cache buckets and must be summed.
const mapUsage = (response: ResponsesResult, upstreamServiceTier: ResponsesResult['service_tier']): GeminiUsageMetadata | undefined => {
  const usage = response.usage;
  if (!usage) return undefined;

  const cachedTokens = usage.input_tokens_details?.cached_tokens;
  const cacheWriteTokens = usage.input_tokens_details?.cache_write_tokens;
  const writes = splitCacheWriteTokens(cacheWriteTokens, usage[USAGE_BILLING]);
  splitInclusiveInputTokens(usage.input_tokens, cachedTokens, cacheWriteTokens);
  const { output: candidatesTokenCount, reasoning: thoughtsTokenCount } = splitInclusiveOutputTokens(
    usage.output_tokens,
    usage.output_tokens_details?.reasoning_tokens,
  );
  const serviceTier = billableServiceTier(upstreamServiceTier);

  return {
    promptTokenCount: usage.input_tokens,
    candidatesTokenCount,
    totalTokenCount: usage.total_tokens,
    ...(usage.output_tokens_details?.reasoning_tokens !== undefined
      ? {
          thoughtsTokenCount,
        }
      : {}),
    ...(cachedTokens !== undefined
      ? {
          cachedContentTokenCount: cachedTokens,
        }
      : {}),
    ...(cacheWriteTokens !== undefined || serviceTier !== null
      ? {
          [USAGE_BILLING]: {
            ...(cacheWriteTokens !== undefined ? { cacheWriteTokenCount: writes.cacheWrite } : {}),
            ...(writes.cacheWrite1h > 0 ? { cacheWrite1hTokenCount: writes.cacheWrite1h } : {}),
            ...(serviceTier !== null ? { serviceTier } : {}),
          },
        }
      : {}),
  };
};

const isSafetyFailure = (response: ResponsesResult): boolean => {
  const error = response.error;
  if (!error) return false;

  const text = `${error.type} ${error.code} ${error.message}`.toLowerCase();
  return text.includes('safety') || text.includes('content_filter') || text.includes('policy');
};

const mapTerminalFinishReason = (event: ResponsesTerminalEvent): GeminiFinishReason => {
  if (event.type === 'response.completed') return 'STOP';
  if (event.type === 'response.failed') {
    return isSafetyFailure(event.response) ? 'SAFETY' : 'OTHER';
  }

  return event.response.incomplete_details?.reason === 'max_output_tokens' ? 'MAX_TOKENS' : 'OTHER';
};

const UPSTREAM_RESPONSES_MISSING_TERMINAL_MESSAGE = 'Upstream Responses stream ended without a terminal event.';

const upstreamResponsesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): AsyncGenerator<ResponsesStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;

    yield frame.event;
    if (frame.event.type === 'response.completed' || frame.event.type === 'response.incomplete' || frame.event.type === 'response.failed' || frame.event.type === 'error') {
      return;
    }
  }

  throw new Error(UPSTREAM_RESPONSES_MISSING_TERMINAL_MESSAGE);
};

type ResponsesEvent<T extends string> = Extract<ResponsesStreamEvent, { type: T }>;

interface ResponsesFunctionCallDraft {
  id?: string;
  name?: string;
  argsJson: string;
}

interface ResponsesToGeminiStreamState {
  functionCalls: Map<number, ResponsesFunctionCallDraft>;
  emittedReasoningKeys: Set<string>;
  emittedTextKeys: Set<string>;
  serviceTier?: ResponsesResult['service_tier'];
}

const responsesPartKey = (outputIndex: number, partIndex: number): string => `${outputIndex}:${partIndex}`;

const emitTextPart = (part: GeminiPart): ProtocolFrame<GeminiStreamEvent> => eventFrame(geminiCandidateEvent([part]));

const reasoningItemDoneFrames = function* (item: ResponsesOutputReasoning, outputIndex: number, state: ResponsesToGeminiStreamState): Generator<ProtocolFrame<GeminiStreamEvent>> {
  for (const [summaryIndex, part] of item.summary.entries()) {
    const key = responsesPartKey(outputIndex, summaryIndex);
    if (!part.text || state.emittedReasoningKeys.has(key)) continue;

    state.emittedReasoningKeys.add(key);
    yield eventFrame(geminiCandidateEvent([{ text: part.text, thought: true }]));
  }
};

const functionCallDoneFrame = (item: ResponsesOutputFunctionCall, outputIndex: number, state: ResponsesToGeminiStreamState): ProtocolFrame<GeminiStreamEvent> => {
  const current = state.functionCalls.get(outputIndex);
  state.functionCalls.delete(outputIndex);

  const draft = current ?? {
    id: item.call_id,
    name: item.name,
    argsJson: item.arguments,
  };
  let argsJson = item.arguments;
  if (current?.argsJson) argsJson = current.argsJson;

  if (!draft.name) {
    throw new Error('Responses function call ended without a name.');
  }

  return emitTextPart(
    {
      functionCall: {
        ...(draft.id !== undefined ? { id: draft.id } : {}),
        name: draft.name,
        args: argsJson ? parseStrictJsonObject(argsJson, 'Responses function call arguments') : {},
      },
    },
  );
};

const handleTerminal = (event: ResponsesTerminalEvent, state: ResponsesToGeminiStreamState): ProtocolFrame<GeminiStreamEvent> => {
  if (event.response.service_tier !== undefined) state.serviceTier = event.response.service_tier;
  return eventFrame(geminiCandidateEvent([], mapTerminalFinishReason(event), mapUsage(event.response, state.serviceTier)));
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
  const state: ResponsesToGeminiStreamState = {
    functionCalls: new Map(),
    emittedReasoningKeys: new Set(),
    emittedTextKeys: new Set(),
  };

  for await (const event of upstreamResponsesEventsUntilTerminal(frames)) {
    switch (event.type) {
    case 'response.created': {
      const response = (event as ResponsesEvent<'response.created'>).response;
      if (response.service_tier !== undefined) state.serviceTier = response.service_tier;
      break;
    }

    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_summary_text.done': {
      const textEvent = event as ResponsesEvent<'response.reasoning_summary_text.delta'> | ResponsesEvent<'response.reasoning_summary_text.done'>;
      const text = textEvent.type === 'response.reasoning_summary_text.delta' ? textEvent.delta : textEvent.text;
      if (!text) break;

      const key = responsesPartKey(textEvent.output_index, textEvent.summary_index);
      if (textEvent.type === 'response.reasoning_summary_text.done' && state.emittedReasoningKeys.has(key)) break;

      state.emittedReasoningKeys.add(key);
      yield eventFrame(geminiCandidateEvent([{ text, thought: true }]));
      break;
    }

    case 'response.output_text.delta':
    case 'response.output_text.done': {
      const textEvent = event as ResponsesEvent<'response.output_text.delta'> | ResponsesEvent<'response.output_text.done'>;
      const text = textEvent.type === 'response.output_text.delta' ? textEvent.delta : textEvent.text;
      if (!text) break;

      const key = responsesPartKey(textEvent.output_index, textEvent.content_index);
      if (textEvent.type === 'response.output_text.done' && state.emittedTextKeys.has(key)) break;

      state.emittedTextKeys.add(key);
      yield emitTextPart({ text });
      break;
    }

    case 'response.output_item.added': {
      const addedEvent = event as ResponsesEvent<'response.output_item.added'>;
      if (addedEvent.item.type === 'function_call') {
        state.functionCalls.set(addedEvent.output_index, {
          id: addedEvent.item.call_id,
          name: addedEvent.item.name,
          argsJson: addedEvent.item.arguments,
        });
      }
      break;
    }

    case 'response.function_call_arguments.delta': {
      const deltaEvent = event as ResponsesEvent<'response.function_call_arguments.delta'>;
      const current = state.functionCalls.get(deltaEvent.output_index);
      if (current) current.argsJson += deltaEvent.delta;
      break;
    }

    case 'response.function_call_arguments.done': {
      const doneEvent = event as ResponsesEvent<'response.function_call_arguments.done'>;
      const current = state.functionCalls.get(doneEvent.output_index);
      if (current) current.argsJson = doneEvent.arguments;
      break;
    }

    case 'response.output_item.done': {
      const doneEvent = event as ResponsesEvent<'response.output_item.done'>;
      if (doneEvent.item.type === 'reasoning') {
        yield* reasoningItemDoneFrames(doneEvent.item, doneEvent.output_index, state);
      } else if (doneEvent.item.type === 'function_call') {
        yield functionCallDoneFrame(doneEvent.item, doneEvent.output_index, state);
      }
      break;
    }

    case 'response.completed':
    case 'response.incomplete':
    case 'response.failed':
      yield handleTerminal(event as ResponsesTerminalEvent, state);
      break;

    case 'error': {
      const errorEvent = event as ResponsesEvent<'error'>;
      throw new Error(`Upstream Responses stream error: ${errorEvent.message}`, { cause: errorEvent });
    }

    default:
      break;
    }
  }
};
