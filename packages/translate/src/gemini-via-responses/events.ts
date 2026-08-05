import { geminiCandidateEvent, parseStrictJsonObject } from '../shared/gemini-via/gemini.ts';
import { authoritativeStreamSuffix } from '../shared/via-responses/authoritative-stream-value.ts';
import { responsesPartKey } from '../shared/via-responses/responses-stream.ts';
import { eventFrame, splitInclusiveInputTokens, splitInclusiveOutputTokens, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiFinishReason, GeminiPart, GeminiStreamEvent, GeminiUsageMetadata } from '@floway-dev/protocols/gemini';
import { isResponsesTerminalEvent, type ResponsesOutputFunctionCall, type ResponsesOutputReasoning, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';

// Responses input_tokens already includes input_tokens_details.cached_tokens,
// matching Gemini's inclusive promptTokenCount semantics. Pass both through
// directly — no folding. Contrast with gemini-via-messages, where Anthropic's
// input_tokens excludes cache buckets and must be summed.
const mapUsage = (response: ResponsesResult): GeminiUsageMetadata | undefined => {
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

const isSafetyFailure = (response: ResponsesResult): boolean => {
  const error = response.error;
  if (!error) return false;

  const text = `${error.type} ${error.code} ${error.message}`.toLowerCase();
  return text.includes('safety') || text.includes('content_filter') || text.includes('policy');
};

const mapTerminalFinishReason = (event: Extract<ResponsesStreamEvent, { type: 'response.completed' | 'response.incomplete' | 'response.failed' }>): GeminiFinishReason => {
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
    if (isResponsesTerminalEvent(frame.event)) {
      return;
    }
  }

  throw new Error(UPSTREAM_RESPONSES_MISSING_TERMINAL_MESSAGE);
};

interface ResponsesFunctionCallDraft {
  id?: string;
  name?: string;
  argsJson: string;
}

interface ResponsesToGeminiStreamState {
  functionCalls: Map<number, ResponsesFunctionCallDraft>;
  reasoningTexts: Map<string, string>;
  outputTexts: Map<string, string>;
  serviceTier?: ResponsesResult['service_tier'];
}

const emitTextPart = (part: GeminiPart): ProtocolFrame<GeminiStreamEvent> => eventFrame(geminiCandidateEvent([part]));

const reasoningItemDoneFrames = function* (item: ResponsesOutputReasoning, outputIndex: number, state: ResponsesToGeminiStreamState): Generator<ProtocolFrame<GeminiStreamEvent>> {
  for (const [summaryIndex, part] of item.summary.entries()) {
    const key = responsesPartKey(outputIndex, summaryIndex);
    const streamed = state.reasoningTexts.get(key) ?? '';
    const suffix = authoritativeStreamSuffix(streamed, part.text, `Responses reasoning summary ${key}`);
    if (part.text) state.reasoningTexts.set(key, part.text);
    if (!suffix) continue;

    yield eventFrame(geminiCandidateEvent([{ text: suffix, thought: true }]));
  }
};

const functionCallDoneFrame = (item: ResponsesOutputFunctionCall, outputIndex: number, state: ResponsesToGeminiStreamState): ProtocolFrame<GeminiStreamEvent> => {
  const current = state.functionCalls.get(outputIndex);
  state.functionCalls.delete(outputIndex);

  const id = item.call_id;
  const name = item.name;
  const argsJson = item.arguments.length > 0 ? item.arguments : current?.argsJson ?? '';

  if (!name) {
    throw new Error('Responses function call ended without a name.');
  }

  return emitTextPart(
    {
      functionCall: {
        ...(id !== undefined ? { id } : {}),
        name,
        args: argsJson ? parseStrictJsonObject(argsJson, 'Responses function call arguments') : {},
      },
    },
  );
};

const handleTerminal = (event: Extract<ResponsesStreamEvent, { type: 'response.completed' | 'response.incomplete' | 'response.failed' }>, state: ResponsesToGeminiStreamState): ProtocolFrame<GeminiStreamEvent> => {
  if (event.response.service_tier !== undefined) state.serviceTier = event.response.service_tier;
  return eventFrame(geminiCandidateEvent([], mapTerminalFinishReason(event), mapUsage(event.response)));
};

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
  const state: ResponsesToGeminiStreamState = {
    functionCalls: new Map(),
    reasoningTexts: new Map(),
    outputTexts: new Map(),
  };

  for await (const event of upstreamResponsesEventsUntilTerminal(frames)) {
    switch (event.type) {
    case 'response.created': {
      const response = (event as Extract<ResponsesStreamEvent, { type: 'response.created' }>).response;
      if (response.service_tier !== undefined) state.serviceTier = response.service_tier;
      break;
    }

    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_summary_text.done': {
      const textEvent = event as Extract<ResponsesStreamEvent, { type: 'response.reasoning_summary_text.delta' }> | Extract<ResponsesStreamEvent, { type: 'response.reasoning_summary_text.done' }>;
      const text = textEvent.type === 'response.reasoning_summary_text.delta' ? textEvent.delta : textEvent.text;
      if (!text) break;

      const key = responsesPartKey(textEvent.output_index, textEvent.summary_index);
      const streamed = state.reasoningTexts.get(key) ?? '';
      const emitted = textEvent.type === 'response.reasoning_summary_text.delta'
        ? text
        : authoritativeStreamSuffix(streamed, text, `Responses reasoning summary ${key}`);
      state.reasoningTexts.set(key, textEvent.type === 'response.reasoning_summary_text.delta' ? streamed + text : text);
      if (emitted) yield eventFrame(geminiCandidateEvent([{ text: emitted, thought: true }]));
      break;
    }

    case 'response.output_text.delta':
    case 'response.output_text.done': {
      const textEvent = event as Extract<ResponsesStreamEvent, { type: 'response.output_text.delta' }> | Extract<ResponsesStreamEvent, { type: 'response.output_text.done' }>;
      const text = textEvent.type === 'response.output_text.delta' ? textEvent.delta : textEvent.text;
      if (!text) break;

      const key = responsesPartKey(textEvent.output_index, textEvent.content_index);
      const streamed = state.outputTexts.get(key) ?? '';
      const emitted = textEvent.type === 'response.output_text.delta'
        ? text
        : authoritativeStreamSuffix(streamed, text, `Responses output text ${key}`);
      state.outputTexts.set(key, textEvent.type === 'response.output_text.delta' ? streamed + text : text);
      if (emitted) yield emitTextPart({ text: emitted });
      break;
    }

    case 'response.output_item.added': {
      const addedEvent = event as Extract<ResponsesStreamEvent, { type: 'response.output_item.added' }>;
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
      const deltaEvent = event as Extract<ResponsesStreamEvent, { type: 'response.function_call_arguments.delta' }>;
      const current = state.functionCalls.get(deltaEvent.output_index);
      if (current) current.argsJson += deltaEvent.delta;
      break;
    }

    case 'response.function_call_arguments.done': {
      const doneEvent = event as Extract<ResponsesStreamEvent, { type: 'response.function_call_arguments.done' }>;
      const current = state.functionCalls.get(doneEvent.output_index);
      if (current) current.argsJson = doneEvent.arguments;
      break;
    }

    case 'response.output_item.done': {
      const doneEvent = event as Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }>;
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
      yield handleTerminal(event as Extract<ResponsesStreamEvent, { type: 'response.completed' | 'response.incomplete' | 'response.failed' }>, state);
      break;

    case 'error': {
      const errorEvent = event as Extract<ResponsesStreamEvent, { type: 'error' }>;
      throw new Error(`Upstream Responses stream error: ${errorEvent.message}`, { cause: errorEvent });
    }

    default:
      break;
    }
  }
};
