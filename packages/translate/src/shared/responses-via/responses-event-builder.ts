import type * as Responses from '@floway-dev/protocols/responses';

type ResponsesOutputContentBlock = Responses.ResponsesOutputContentBlock;
type ResponsesOutputCustomToolCall = Responses.ResponsesOutputCustomToolCall;
type ResponsesOutputFunctionCall = Responses.ResponsesOutputFunctionCall;
type ResponsesOutputItem = Responses.ResponsesOutputItem;
type ResponsesOutputMessage = Responses.ResponsesOutputMessage;
type ResponsesOutputReasoning = Responses.ResponsesOutputReasoning;
type ResponsesResult = Responses.ResponsesResult;
type ResponsesStreamEvent = Responses.ResponsesStreamEvent;

export interface ResponsesSequenceState {
  sequenceNumber: number;
}

type OutputTextPart = Extract<ResponsesOutputContentBlock, { type: 'output_text' }>;
type RefusalPart = Extract<ResponsesOutputContentBlock, { type: 'refusal' }>;
type ResponsesUsage = NonNullable<ResponsesResult['usage']>;

export const textPart = (text: string, annotations: Responses.ResponsesAnnotation[]): OutputTextPart => ({
  type: 'output_text',
  text,
  annotations,
});

export const refusalPart = (refusal: string): RefusalPart => ({
  type: 'refusal',
  refusal,
});

const summaryPart = (text: string) => ({ type: 'summary_text' as const, text });

const outputItemEvent = (state: 'added' | 'done', outputIndex: number, item: ResponsesOutputItem): ResponsesStreamEvent => ({
  type: `response.output_item.${state}`,
  output_index: outputIndex,
  item,
});

const outputTextEvent = (state: 'delta' | 'done', outputIndex: number, itemId: string, text: string): ResponsesStreamEvent =>
  ({
    type: `response.output_text.${state}`,
    item_id: itemId,
    output_index: outputIndex,
    content_index: 0,
    [state === 'delta' ? 'delta' : 'text']: text,
  } as ResponsesStreamEvent);

const refusalEvent = (state: 'delta' | 'done', outputIndex: number, itemId: string, refusal: string): ResponsesStreamEvent =>
  ({
    type: `response.refusal.${state}`,
    item_id: itemId,
    output_index: outputIndex,
    content_index: 0,
    [state === 'delta' ? 'delta' : 'refusal']: refusal,
  } as ResponsesStreamEvent);

const functionCallArgumentsEvent = (state: 'delta' | 'done', outputIndex: number, itemId: string, text: string): ResponsesStreamEvent =>
  ({
    type: `response.function_call_arguments.${state}`,
    item_id: itemId,
    output_index: outputIndex,
    [state === 'delta' ? 'delta' : 'arguments']: text,
  } as ResponsesStreamEvent);

const customToolCallInputEvent = (state: 'delta' | 'done', outputIndex: number, itemId: string, text: string): ResponsesStreamEvent =>
  ({
    type: `response.custom_tool_call_input.${state}`,
    item_id: itemId,
    output_index: outputIndex,
    [state === 'delta' ? 'delta' : 'input']: text,
  } as ResponsesStreamEvent);

const reasoningSummaryPartEvent = (state: 'added' | 'done', outputIndex: number, itemId: string, summaryIndex: number, text: string): ResponsesStreamEvent => ({
  type: `response.reasoning_summary_part.${state}`,
  item_id: itemId,
  output_index: outputIndex,
  summary_index: summaryIndex,
  part: summaryPart(text),
});

const reasoningSummaryTextEvent = (state: 'delta' | 'done', outputIndex: number, itemId: string, summaryIndex: number, text: string): ResponsesStreamEvent =>
  ({
    type: `response.reasoning_summary_text.${state}`,
    item_id: itemId,
    output_index: outputIndex,
    summary_index: summaryIndex,
    [state === 'delta' ? 'delta' : 'text']: text,
  } as ResponsesStreamEvent);

export const seq = (state: ResponsesSequenceState, events: ResponsesStreamEvent[]): ResponsesStreamEvent[] =>
  events.map(event => ({
    ...event,
    sequence_number: state.sequenceNumber++,
  }));

// `incompleteDetails` is an explicit caller-supplied input. Inferring
// it from `status === 'incomplete'` alone would have to hard-code a
// reason — current callers all map to `'max_output_tokens'`, but a
// future caller surfacing `'content_filter'` (or any other reason a
// new SDK enum value adds) would silently get a misleading value.
// Callers pass the right reason; the helper just packages it.
export const result = (input: {
  id: string;
  model: string;
  output: ResponsesOutputItem[];
  outputText: string;
  status: ResponsesResult['status'];
  usage?: ResponsesUsage;
  incompleteDetails?: ResponsesResult['incomplete_details'];
  error?: ResponsesResult['error'];
  serviceTier?: ResponsesResult['service_tier'];
}): ResponsesResult => ({
  id: input.id,
  object: 'response',
  model: input.model,
  output: input.output,
  output_text: input.outputText,
  status: input.status,
  // `error` and `incomplete_details` are spec-required on every
  // Response (both nullable). Default both to null; callers pass a
  // concrete value when the source carries one.
  error: input.error ?? null,
  incomplete_details: input.incompleteDetails ?? null,
  ...(input.usage !== undefined ? { usage: input.usage } : {}),
  ...(input.serviceTier !== undefined ? { service_tier: input.serviceTier } : {}),
});

// A translated producer allocates one item ID when the lifecycle opens and
// reuses it across added, child, done, and terminal frames. Taking the built
// content part rather than its text keeps the item and the `content_part`
// frames carrying one identical part.
export const messageItem = (id: string, status: 'in_progress' | 'completed', part: ResponsesOutputContentBlock): ResponsesOutputMessage => ({
  type: 'message',
  id,
  status,
  role: 'assistant',
  content: [part],
});

export const reasoningItem = (id: string, summaryText: string, encryptedContent?: string): ResponsesOutputReasoning => ({
  type: 'reasoning',
  id,
  summary: summaryText ? [summaryPart(summaryText)] : [],
  ...(encryptedContent !== undefined ? { encrypted_content: encryptedContent } : {}),
});

export const functionCallItem = (
  id: string,
  callId: string,
  name: string,
  args: string,
  status: ResponsesOutputFunctionCall['status'],
  namespace?: string,
): ResponsesOutputFunctionCall => ({
  type: 'function_call',
  id,
  call_id: callId,
  name,
  ...(namespace !== undefined ? { namespace } : {}),
  arguments: args,
  status,
});

export const customToolCallItem = (id: string, callId: string, name: string, input: string): ResponsesOutputCustomToolCall => ({
  type: 'custom_tool_call',
  id,
  call_id: callId,
  name,
  input,
});

export const started = (state: ResponsesSequenceState, response: ResponsesResult) =>
  seq(state, [
    { type: 'response.created', response },
    {
      type: 'response.in_progress',
      response,
    },
  ]);

export const terminal = (state: ResponsesSequenceState, response: ResponsesResult) => {
  let type: 'response.completed' | 'response.incomplete' | 'response.failed';
  switch (response.status) {
  case 'completed': type = 'response.completed'; break;
  case 'incomplete': type = 'response.incomplete'; break;
  case 'failed': type = 'response.failed'; break;
  case 'queued':
  case 'in_progress':
  case 'cancelled':
    throw new TypeError(`Cannot emit a terminal Responses event for status '${response.status}'`);
  }
  return seq(state, [
    {
      type,
      response,
    },
  ]);
};

export const itemAdded = (state: ResponsesSequenceState, outputIndex: number, item: ResponsesOutputItem) =>
  seq(state, [outputItemEvent('added', outputIndex, item)]);

export const textStart = (state: ResponsesSequenceState, outputIndex: number, itemId: string) => {
  const part = textPart('', []);
  return seq(state, [
    outputItemEvent('added', outputIndex, messageItem(itemId, 'in_progress', part)),
    {
      type: 'response.content_part.added',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part,
    },
  ]);
};

export const textDelta = (state: ResponsesSequenceState, outputIndex: number, itemId: string, delta: string) =>
  seq(state, [outputTextEvent('delta', outputIndex, itemId, delta)]);

export const textDone = (state: ResponsesSequenceState, outputIndex: number, itemId: string, part: OutputTextPart, item: ResponsesOutputMessage) =>
  seq(state, [
    outputTextEvent('done', outputIndex, itemId, part.text),
    {
      type: 'response.content_part.done',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part,
    },
    outputItemEvent('done', outputIndex, item),
  ]);

export const refusalStart = (state: ResponsesSequenceState, outputIndex: number, itemId: string) => {
  const part = refusalPart('');
  return seq(state, [
    outputItemEvent('added', outputIndex, messageItem(itemId, 'in_progress', part)),
    {
      type: 'response.content_part.added',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part,
    },
  ]);
};

export const refusalDelta = (state: ResponsesSequenceState, outputIndex: number, itemId: string, delta: string) =>
  seq(state, [refusalEvent('delta', outputIndex, itemId, delta)]);

export const refusalDone = (state: ResponsesSequenceState, outputIndex: number, itemId: string, part: RefusalPart, item: ResponsesOutputMessage) =>
  seq(state, [
    refusalEvent('done', outputIndex, itemId, part.refusal),
    {
      type: 'response.content_part.done',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part,
    },
    outputItemEvent('done', outputIndex, item),
  ]);

export const argumentsDelta = (state: ResponsesSequenceState, outputIndex: number, itemId: string, delta: string) =>
  seq(state, [functionCallArgumentsEvent('delta', outputIndex, itemId, delta)]);

export const functionCallDone = (state: ResponsesSequenceState, outputIndex: number, itemId: string, args: string, item: ResponsesOutputFunctionCall) =>
  seq(state, [functionCallArgumentsEvent('done', outputIndex, itemId, args), outputItemEvent('done', outputIndex, item)]);

export const customToolCallDone = (state: ResponsesSequenceState, outputIndex: number, itemId: string, input: string, item: ResponsesOutputCustomToolCall) =>
  seq(state, [
    ...(input.length > 0 ? [customToolCallInputEvent('delta', outputIndex, itemId, input)] : []),
    customToolCallInputEvent('done', outputIndex, itemId, input),
    outputItemEvent('done', outputIndex, item),
  ]);

export const reasoningStart = (state: ResponsesSequenceState, outputIndex: number, itemId: string) =>
  seq(state, [outputItemEvent('added', outputIndex, reasoningItem(itemId, '')), reasoningSummaryPartEvent('added', outputIndex, itemId, 0, '')]);

export const reasoningDelta = (state: ResponsesSequenceState, outputIndex: number, itemId: string, delta: string) =>
  seq(state, [reasoningSummaryTextEvent('delta', outputIndex, itemId, 0, delta)]);

export const reasoningDone = (state: ResponsesSequenceState, outputIndex: number, itemId: string, summaryText: string, item: ResponsesOutputReasoning) =>
  seq(state, [
    ...(summaryText ? [reasoningSummaryTextEvent('done', outputIndex, itemId, 0, summaryText)] : []),
    reasoningSummaryPartEvent('done', outputIndex, itemId, 0, summaryText),
    outputItemEvent('done', outputIndex, item),
  ]);

export const completedReasoning = (state: ResponsesSequenceState, outputIndex: number, item: ResponsesOutputReasoning) =>
  seq(state, [
    outputItemEvent('added', outputIndex, item),
    ...item.summary.flatMap((part, summaryIndex) => [
      reasoningSummaryPartEvent('added', outputIndex, item.id, summaryIndex, part.text),
      reasoningSummaryTextEvent('done', outputIndex, item.id, summaryIndex, part.text),
      reasoningSummaryPartEvent('done', outputIndex, item.id, summaryIndex, part.text),
    ]),
    outputItemEvent('done', outputIndex, item),
  ]);
