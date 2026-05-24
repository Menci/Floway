import { geminiResponse, parseStrictJsonObject } from '../shared/gemini-via/gemini.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiFinishReason, GeminiPart, GeminiStreamEvent, GeminiUsageMetadata } from '@floway-dev/protocols/gemini';
import type { ResponseOutputFunctionCall, ResponseOutputReasoning, ResponsesResult, ResponseStreamEvent } from '@floway-dev/protocols/responses';

type ResponseTerminalEvent = Extract<ResponseStreamEvent, { type: 'response.completed' } | { type: 'response.incomplete' } | { type: 'response.failed' }>;

// Responses input_tokens already includes input_tokens_details.cached_tokens,
// matching Gemini's inclusive promptTokenCount semantics. Pass both through
// directly — no folding. Contrast with gemini-via-messages, where Anthropic's
// input_tokens excludes cache buckets and must be summed.
const mapUsage = (usage: ResponsesResult['usage']): GeminiUsageMetadata | undefined => {
  if (!usage) return undefined;

  return {
    promptTokenCount: usage.input_tokens,
    candidatesTokenCount: usage.output_tokens,
    totalTokenCount: usage.total_tokens,
    ...(usage.output_tokens_details?.reasoning_tokens !== undefined
      ? {
          thoughtsTokenCount: usage.output_tokens_details.reasoning_tokens,
        }
      : {}),
    ...(usage.input_tokens_details?.cached_tokens !== undefined
      ? {
          cachedContentTokenCount: usage.input_tokens_details.cached_tokens,
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

const mapTerminalFinishReason = (event: ResponseTerminalEvent): GeminiFinishReason => {
  if (event.type === 'response.completed') return 'STOP';
  if (event.type === 'response.failed') {
    return isSafetyFailure(event.response) ? 'SAFETY' : 'OTHER';
  }

  return event.response.incomplete_details?.reason === 'max_output_tokens' ? 'MAX_TOKENS' : 'OTHER';
};

const UPSTREAM_RESPONSES_MISSING_TERMINAL_MESSAGE = 'Upstream Responses stream ended without a terminal event.';

const upstreamResponsesEventsUntilTerminal = async function* (frames: AsyncIterable<ProtocolFrame<ResponseStreamEvent>>): AsyncGenerator<ResponseStreamEvent> {
  for await (const frame of frames) {
    if (frame.type === 'done') continue;

    yield frame.event;
    if (frame.event.type === 'response.completed' || frame.event.type === 'response.incomplete' || frame.event.type === 'response.failed' || frame.event.type === 'error') {
      return;
    }
  }

  throw new Error(UPSTREAM_RESPONSES_MISSING_TERMINAL_MESSAGE);
};

type ResponseEvent<T extends string> = Extract<ResponseStreamEvent, { type: T }>;

interface ResponseFunctionCallDraft {
  id?: string;
  name?: string;
  argsJson: string;
}

interface GeminiViaResponsesStreamState {
  functionCalls: Map<number, ResponseFunctionCallDraft>;
  emittedReasoningKeys: Set<string>;
  emittedTextKeys: Set<string>;
}

const responsePartKey = (outputIndex: number, partIndex: number): string => `${outputIndex}:${partIndex}`;

const emitTextPart = (part: GeminiPart): ProtocolFrame<GeminiStreamEvent> => eventFrame(geminiResponse([part]));

const reasoningItemDoneFrames = function* (item: ResponseOutputReasoning, outputIndex: number, state: GeminiViaResponsesStreamState): Generator<ProtocolFrame<GeminiStreamEvent>> {
  for (const [summaryIndex, part] of item.summary.entries()) {
    const key = responsePartKey(outputIndex, summaryIndex);
    if (!part.text || state.emittedReasoningKeys.has(key)) continue;

    state.emittedReasoningKeys.add(key);
    yield eventFrame(geminiResponse([{ text: part.text, thought: true }]));
  }
};

const functionCallDoneFrame = (item: ResponseOutputFunctionCall, outputIndex: number, state: GeminiViaResponsesStreamState): ProtocolFrame<GeminiStreamEvent> => {
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

const handleTerminal = (event: ResponseTerminalEvent): ProtocolFrame<GeminiStreamEvent> =>
  eventFrame(geminiResponse([], mapTerminalFinishReason(event), mapUsage(event.response.usage)));

export const translateToSourceEvents = async function* (frames: AsyncIterable<ProtocolFrame<ResponseStreamEvent>>): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
  const state: GeminiViaResponsesStreamState = {
    functionCalls: new Map(),
    emittedReasoningKeys: new Set(),
    emittedTextKeys: new Set(),
  };

  for await (const event of upstreamResponsesEventsUntilTerminal(frames)) {
    switch (event.type) {
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_summary_text.done': {
      const textEvent = event as ResponseEvent<'response.reasoning_summary_text.delta'> | ResponseEvent<'response.reasoning_summary_text.done'>;
      const text = textEvent.type === 'response.reasoning_summary_text.delta' ? textEvent.delta : textEvent.text;
      if (!text) break;

      const key = responsePartKey(textEvent.output_index, textEvent.summary_index);
      if (textEvent.type === 'response.reasoning_summary_text.done' && state.emittedReasoningKeys.has(key)) break;

      state.emittedReasoningKeys.add(key);
      yield eventFrame(geminiResponse([{ text, thought: true }]));
      break;
    }

    case 'response.output_text.delta':
    case 'response.output_text.done': {
      const textEvent = event as ResponseEvent<'response.output_text.delta'> | ResponseEvent<'response.output_text.done'>;
      const text = textEvent.type === 'response.output_text.delta' ? textEvent.delta : textEvent.text;
      if (!text) break;

      const key = responsePartKey(textEvent.output_index, textEvent.content_index);
      if (textEvent.type === 'response.output_text.done' && state.emittedTextKeys.has(key)) break;

      state.emittedTextKeys.add(key);
      yield emitTextPart({ text });
      break;
    }

    case 'response.output_item.added': {
      const addedEvent = event as ResponseEvent<'response.output_item.added'>;
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
      const deltaEvent = event as ResponseEvent<'response.function_call_arguments.delta'>;
      const current = state.functionCalls.get(deltaEvent.output_index);
      if (current) current.argsJson += deltaEvent.delta;
      break;
    }

    case 'response.function_call_arguments.done': {
      const doneEvent = event as ResponseEvent<'response.function_call_arguments.done'>;
      const current = state.functionCalls.get(doneEvent.output_index);
      if (current) current.argsJson = doneEvent.arguments;
      break;
    }

    case 'response.output_item.done': {
      const doneEvent = event as ResponseEvent<'response.output_item.done'>;
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
      yield handleTerminal(event as ResponseTerminalEvent);
      break;

    case 'error': {
      const errorEvent = event as ResponseEvent<'error'>;
      throw new Error(`Upstream Responses stream error: ${errorEvent.message}`, { cause: errorEvent });
    }

    default:
      break;
    }
  }
};
