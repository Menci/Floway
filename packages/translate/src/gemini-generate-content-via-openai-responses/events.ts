import { geminiGenerateContentCandidateEvent, parseStrictJsonObject } from '../shared/gemini-generate-content-via/gemini-generate-content.ts';
import { eventFrame, splitInclusiveInputTokens, splitInclusiveOutputTokens, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentFinishReason, GeminiGenerateContentPart, GeminiGenerateContentStreamEvent, GeminiGenerateContentUsageMetadata } from '@floway-dev/protocols/gemini-generate-content';
import { isOpenAIResponsesTerminalEvent, type OpenAIResponsesOutputFunctionCall, type OpenAIResponsesOutputReasoning, type OpenAIResponsesResult, type OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

// OpenAI Responses input_tokens already includes input_tokens_details.cached_tokens,
// matching Gemini's inclusive promptTokenCount semantics. Pass both through
// directly — no folding. Contrast with gemini-generate-content-via-anthropic-messages, where Anthropic's
// input_tokens excludes cache buckets and must be summed.
const mapUsage = (response: OpenAIResponsesResult): GeminiGenerateContentUsageMetadata | undefined => {
  const usage = response.usage;
  if (!usage) return undefined;

  const cachedTokens = usage.input_tokens_details?.cached_tokens;
  const cacheWriteTokens = usage.input_tokens_details?.cache_write_tokens;
  splitInclusiveInputTokens(usage.input_tokens, cachedTokens, cacheWriteTokens);
  const { output: candidatesTokenCount, reasoning: thoughtsTokenCount } = splitInclusiveOutputTokens(
    usage.output_tokens,
    usage.output_tokens_details?.reasoning_tokens,
  );

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
  };
};

const isSafetyFailure = (response: OpenAIResponsesResult): boolean => {
  const error = response.error;
  if (!error) return false;

  const text = `${error.type} ${error.code} ${error.message}`.toLowerCase();
  return text.includes('safety') || text.includes('content_filter') || text.includes('policy');
};

const mapTerminalFinishReason = (event: Extract<OpenAIResponsesStreamEvent, { type: 'response.completed' | 'response.incomplete' | 'response.failed' }>): GeminiGenerateContentFinishReason => {
  if (event.type === 'response.completed') return 'STOP';
  if (event.type === 'response.failed') {
    return isSafetyFailure(event.response) ? 'SAFETY' : 'OTHER';
  }

  return event.response.incomplete_details?.reason === 'max_output_tokens' ? 'MAX_TOKENS' : 'OTHER';
};

const UPSTREAM_OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE = 'Upstream OpenAI Responses stream ended without a terminal event.';

const upstreamOpenAIResponsesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>): AsyncGenerator<OpenAIResponsesStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;

    yield frame.event;
    if (isOpenAIResponsesTerminalEvent(frame.event)) {
      return;
    }
  }

  throw new Error(UPSTREAM_OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE);
};

interface OpenAIResponsesFunctionCallDraft {
  id?: string;
  name?: string;
  argsJson: string;
}

interface OpenAIResponsesToGeminiGenerateContentStreamState {
  functionCalls: Map<number, OpenAIResponsesFunctionCallDraft>;
  emittedReasoningKeys: Set<string>;
  emittedTextKeys: Set<string>;
  serviceTier?: OpenAIResponsesResult['service_tier'];
}

const openaiResponsesPartKey = (outputIndex: number, partIndex: number): string => `${outputIndex}:${partIndex}`;

const emitTextPart = (part: GeminiGenerateContentPart): ProtocolFrame<GeminiGenerateContentStreamEvent> => eventFrame(geminiGenerateContentCandidateEvent([part]));

const reasoningItemDoneFrames = function* (item: OpenAIResponsesOutputReasoning, outputIndex: number, state: OpenAIResponsesToGeminiGenerateContentStreamState): Generator<ProtocolFrame<GeminiGenerateContentStreamEvent>> {
  for (const [summaryIndex, part] of item.summary.entries()) {
    const key = openaiResponsesPartKey(outputIndex, summaryIndex);
    if (!part.text || state.emittedReasoningKeys.has(key)) continue;

    state.emittedReasoningKeys.add(key);
    yield eventFrame(geminiGenerateContentCandidateEvent([{ text: part.text, thought: true }]));
  }
};

const functionCallDoneFrame = (item: OpenAIResponsesOutputFunctionCall, outputIndex: number, state: OpenAIResponsesToGeminiGenerateContentStreamState): ProtocolFrame<GeminiGenerateContentStreamEvent> => {
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
    throw new Error('OpenAI Responses function call ended without a name.');
  }

  return emitTextPart(
    {
      functionCall: {
        ...(draft.id !== undefined ? { id: draft.id } : {}),
        name: draft.name,
        args: argsJson ? parseStrictJsonObject(argsJson, 'OpenAI Responses function call arguments') : {},
      },
    },
  );
};

const handleTerminal = (event: Extract<OpenAIResponsesStreamEvent, { type: 'response.completed' | 'response.incomplete' | 'response.failed' }>, state: OpenAIResponsesToGeminiGenerateContentStreamState): ProtocolFrame<GeminiGenerateContentStreamEvent> => {
  if (event.response.service_tier !== undefined) state.serviceTier = event.response.service_tier;
  return eventFrame(geminiGenerateContentCandidateEvent([], mapTerminalFinishReason(event), mapUsage(event.response)));
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> {
  const state: OpenAIResponsesToGeminiGenerateContentStreamState = {
    functionCalls: new Map(),
    emittedReasoningKeys: new Set(),
    emittedTextKeys: new Set(),
  };

  for await (const event of upstreamOpenAIResponsesEventsUntilTerminal(frames)) {
    switch (event.type) {
    case 'response.created': {
      const response = (event as Extract<OpenAIResponsesStreamEvent, { type: 'response.created' }>).response;
      if (response.service_tier !== undefined) state.serviceTier = response.service_tier;
      break;
    }

    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_summary_text.done': {
      const textEvent = event as Extract<OpenAIResponsesStreamEvent, { type: 'response.reasoning_summary_text.delta' }> | Extract<OpenAIResponsesStreamEvent, { type: 'response.reasoning_summary_text.done' }>;
      const text = textEvent.type === 'response.reasoning_summary_text.delta' ? textEvent.delta : textEvent.text;
      if (!text) break;

      const key = openaiResponsesPartKey(textEvent.output_index, textEvent.summary_index);
      if (textEvent.type === 'response.reasoning_summary_text.done' && state.emittedReasoningKeys.has(key)) break;

      state.emittedReasoningKeys.add(key);
      yield eventFrame(geminiGenerateContentCandidateEvent([{ text, thought: true }]));
      break;
    }

    case 'response.output_text.delta':
    case 'response.output_text.done': {
      const textEvent = event as Extract<OpenAIResponsesStreamEvent, { type: 'response.output_text.delta' }> | Extract<OpenAIResponsesStreamEvent, { type: 'response.output_text.done' }>;
      const text = textEvent.type === 'response.output_text.delta' ? textEvent.delta : textEvent.text;
      if (!text) break;

      const key = openaiResponsesPartKey(textEvent.output_index, textEvent.content_index);
      if (textEvent.type === 'response.output_text.done' && state.emittedTextKeys.has(key)) break;

      state.emittedTextKeys.add(key);
      yield emitTextPart({ text });
      break;
    }

    case 'response.output_item.added': {
      const addedEvent = event as Extract<OpenAIResponsesStreamEvent, { type: 'response.output_item.added' }>;
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
      const deltaEvent = event as Extract<OpenAIResponsesStreamEvent, { type: 'response.function_call_arguments.delta' }>;
      const current = state.functionCalls.get(deltaEvent.output_index);
      if (current) current.argsJson += deltaEvent.delta;
      break;
    }

    case 'response.function_call_arguments.done': {
      const doneEvent = event as Extract<OpenAIResponsesStreamEvent, { type: 'response.function_call_arguments.done' }>;
      const current = state.functionCalls.get(doneEvent.output_index);
      if (current) current.argsJson = doneEvent.arguments;
      break;
    }

    case 'response.output_item.done': {
      const doneEvent = event as Extract<OpenAIResponsesStreamEvent, { type: 'response.output_item.done' }>;
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
      yield handleTerminal(event as Extract<OpenAIResponsesStreamEvent, { type: 'response.completed' | 'response.incomplete' | 'response.failed' }>, state);
      break;

    case 'error': {
      const errorEvent = event as Extract<OpenAIResponsesStreamEvent, { type: 'error' }>;
      throw new Error(`Upstream OpenAI Responses stream error: ${errorEvent.message}`, { cause: errorEvent });
    }

    default:
      break;
    }
  }
};
