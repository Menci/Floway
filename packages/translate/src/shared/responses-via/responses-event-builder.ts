import type * as Responses from '@floway-dev/protocols/responses';

type ResponseOutputContentBlock = Responses.ResponseOutputContentBlock;
type ResponseOutputCustomToolCall = Responses.ResponseOutputCustomToolCall;
type ResponseOutputFunctionCall = Responses.ResponseOutputFunctionCall;
type ResponseOutputItem = Responses.ResponseOutputItem;
type ResponseOutputMessage = Responses.ResponseOutputMessage;
type ResponseOutputReasoning = Responses.ResponseOutputReasoning;
type ResponsesResult = Responses.ResponsesResult;
type ResponseStreamEvent = Responses.ResponseStreamEvent;

export interface ResponsesSequenceState {
  sequenceNumber: number;
}

type OutputTextPart = Extract<ResponseOutputContentBlock, { type: 'output_text' }>;
type ResponseUsage = NonNullable<ResponsesResult['usage']>;

const textPart = (text: string): OutputTextPart => ({
    type: 'output_text',
    text,
  }),
  summaryPart = (text: string) => ({ type: 'summary_text' as const, text }),
  outputItemEvent = (state: 'added' | 'done', outputIndex: number, item: ResponseOutputItem): ResponseStreamEvent => ({
    type: `response.output_item.${state}`,
    output_index: outputIndex,
    item,
  }),
  outputTextEvent = (state: 'delta' | 'done', outputIndex: number, itemId: string, text: string): ResponseStreamEvent =>
    ({
      type: `response.output_text.${state}`,
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      [state === 'delta' ? 'delta' : 'text']: text,
    } as ResponseStreamEvent),
  functionCallArgumentsEvent = (state: 'delta' | 'done', outputIndex: number, itemId: string, text: string): ResponseStreamEvent =>
    ({
      type: `response.function_call_arguments.${state}`,
      item_id: itemId,
      output_index: outputIndex,
      [state === 'delta' ? 'delta' : 'arguments']: text,
    } as ResponseStreamEvent),
  customToolCallInputEvent = (state: 'delta' | 'done', outputIndex: number, itemId: string, text: string): ResponseStreamEvent =>
    ({
      type: `response.custom_tool_call_input.${state}`,
      item_id: itemId,
      output_index: outputIndex,
      [state === 'delta' ? 'delta' : 'input']: text,
    } as ResponseStreamEvent),
  reasoningSummaryPartEvent = (state: 'added' | 'done', outputIndex: number, itemId: string, summaryIndex: number, text: string): ResponseStreamEvent => ({
    type: `response.reasoning_summary_part.${state}`,
    item_id: itemId,
    output_index: outputIndex,
    summary_index: summaryIndex,
    part: summaryPart(text),
  }),
  reasoningSummaryTextEvent = (state: 'delta' | 'done', outputIndex: number, itemId: string, summaryIndex: number, text: string): ResponseStreamEvent =>
    ({
      type: `response.reasoning_summary_text.${state}`,
      item_id: itemId,
      output_index: outputIndex,
      summary_index: summaryIndex,
      [state === 'delta' ? 'delta' : 'text']: text,
    } as ResponseStreamEvent);

export const seq = (state: ResponsesSequenceState, events: ResponseStreamEvent[]): ResponseStreamEvent[] =>
    events.map(event => ({
      ...event,
      sequence_number: state.sequenceNumber++,
    })),
  usage = (inputTokens: number, outputTokens: number, cacheReadInputTokens?: number): ResponseUsage => ({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    ...(cacheReadInputTokens !== undefined ? { input_tokens_details: { cached_tokens: cacheReadInputTokens } } : {}),
  }),
  result = (input: { id: string; model: string; output: ResponseOutputItem[]; outputText: string; status: ResponsesResult['status']; usage?: ResponseUsage }): ResponsesResult => ({
    id: input.id,
    object: 'response',
    model: input.model,
    output: input.output,
    output_text: input.outputText,
    status: input.status,
    ...(input.status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    ...(input.usage !== undefined ? { usage: input.usage } : {}),
  }),
  messageItem = (text: string): ResponseOutputMessage => ({
    type: 'message',
    role: 'assistant',
    content: [textPart(text)],
  }),
  reasoningItem = (id: string, summaryText: string): ResponseOutputReasoning => ({
    type: 'reasoning',
    id,
    summary: summaryText ? [summaryPart(summaryText)] : [],
  }),
  functionCallItem = (callId: string, name: string, args: string, status: ResponseOutputFunctionCall['status']): ResponseOutputFunctionCall => ({
    type: 'function_call',
    call_id: callId,
    name,
    arguments: args,
    status,
  }),
  customToolCallItem = (callId: string, name: string, input: string): ResponseOutputCustomToolCall => ({
    type: 'custom_tool_call',
    call_id: callId,
    name,
    input,
  }),
  started = (state: ResponsesSequenceState, response: ResponsesResult) =>
    seq(state, [
      { type: 'response.created', response },
      {
        type: 'response.in_progress',
        response,
      },
    ]),
  terminal = (state: ResponsesSequenceState, response: ResponsesResult) => {
    if (response.status === 'in_progress') {
      throw new Error('Cannot emit a terminal Responses event for in_progress');
    }
    return seq(state, [
      {
        type: response.status === 'incomplete' ? 'response.incomplete' : response.status === 'failed' ? 'response.failed' : 'response.completed',
        response,
      },
    ]);
  },
  itemAdded = (state: ResponsesSequenceState, outputIndex: number, item: ResponseOutputItem) => seq(state, [outputItemEvent('added', outputIndex, item)]),
  textStart = (state: ResponsesSequenceState, outputIndex: number, itemId: string) =>
    seq(state, [
      outputItemEvent('added', outputIndex, messageItem('')),
      {
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: textPart(''),
      },
    ]),
  textDelta = (state: ResponsesSequenceState, outputIndex: number, itemId: string, delta: string) => seq(state, [outputTextEvent('delta', outputIndex, itemId, delta)]),
  textDone = (state: ResponsesSequenceState, outputIndex: number, itemId: string, text: string, item: ResponseOutputMessage) =>
    seq(state, [
      outputTextEvent('done', outputIndex, itemId, text),
      {
        type: 'response.content_part.done',
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: textPart(text),
      },
      outputItemEvent('done', outputIndex, item),
    ]),
  argumentsDelta = (state: ResponsesSequenceState, outputIndex: number, itemId: string, delta: string) => seq(state, [functionCallArgumentsEvent('delta', outputIndex, itemId, delta)]),
  functionCallDone = (state: ResponsesSequenceState, outputIndex: number, itemId: string, args: string, item: ResponseOutputFunctionCall) =>
    seq(state, [functionCallArgumentsEvent('done', outputIndex, itemId, args), outputItemEvent('done', outputIndex, item)]),
  customToolCallDone = (state: ResponsesSequenceState, outputIndex: number, itemId: string, input: string, item: ResponseOutputCustomToolCall) =>
    seq(state, [
      ...(input.length > 0 ? [customToolCallInputEvent('delta', outputIndex, itemId, input)] : []),
      customToolCallInputEvent('done', outputIndex, itemId, input),
      outputItemEvent('done', outputIndex, item),
    ]),
  reasoningStart = (state: ResponsesSequenceState, outputIndex: number, itemId: string) =>
    seq(state, [outputItemEvent('added', outputIndex, reasoningItem(itemId, '')), reasoningSummaryPartEvent('added', outputIndex, itemId, 0, '')]),
  reasoningDelta = (state: ResponsesSequenceState, outputIndex: number, itemId: string, delta: string) => seq(state, [reasoningSummaryTextEvent('delta', outputIndex, itemId, 0, delta)]),
  reasoningDone = (state: ResponsesSequenceState, outputIndex: number, itemId: string, summaryText: string, item: ResponseOutputReasoning) =>
    seq(state, [
      ...(summaryText ? [reasoningSummaryTextEvent('done', outputIndex, itemId, 0, summaryText)] : []),
      reasoningSummaryPartEvent('done', outputIndex, itemId, 0, summaryText),
      outputItemEvent('done', outputIndex, item),
    ]),
  completedReasoning = (state: ResponsesSequenceState, outputIndex: number, item: ResponseOutputReasoning) =>
    seq(state, [
      outputItemEvent('added', outputIndex, item),
      ...item.summary.flatMap((part, summaryIndex) => [
        reasoningSummaryPartEvent('added', outputIndex, item.id, summaryIndex, part.text),
        reasoningSummaryTextEvent('done', outputIndex, item.id, summaryIndex, part.text),
        reasoningSummaryPartEvent('done', outputIndex, item.id, summaryIndex, part.text),
      ]),
      outputItemEvent('done', outputIndex, item),
    ]);
