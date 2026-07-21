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
type ResponsesUsage = NonNullable<ResponsesResult['usage']>;

const textPart = (text: string): OutputTextPart => ({
  type: 'output_text',
  text,
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
  error: null,
  incomplete_details: input.incompleteDetails ?? null,
  ...(input.usage !== undefined ? { usage: input.usage } : {}),
  ...(input.serviceTier !== undefined ? { service_tier: input.serviceTier } : {}),
});

// Every output item carries its own `id` so that, when a Responses client is
// routed to a non-Responses upstream, the synthesized stream looks like a
// native Responses one: the id on `output_item.added`/`.done` matches the
// `item_id` of every child frame, and the source-serve persistence layer can
// mint a stored id and record the item. Ids are derived from the item's
// output index (see the `msg_`/`fc_`/`ctc_`/`rs_` callers), so they are stable
// within a response and do not parse as gateway stored ids.
export const messageItem = (id: string, text: string): ResponsesOutputMessage => ({
  type: 'message',
  id,
  role: 'assistant',
  content: [textPart(text)],
});

export const reasoningItem = (id: string, summaryText: string, encryptedContent?: string): ResponsesOutputReasoning => ({
  type: 'reasoning',
  id,
  summary: summaryText ? [summaryPart(summaryText)] : [],
  ...(encryptedContent !== undefined ? { encrypted_content: encryptedContent } : {}),
});

export const functionCallItem = (id: string, callId: string, name: string, args: string, status: ResponsesOutputFunctionCall['status']): ResponsesOutputFunctionCall => ({
  type: 'function_call',
  id,
  call_id: callId,
  name,
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

export const textStart = (state: ResponsesSequenceState, outputIndex: number, itemId: string) =>
  seq(state, [
    outputItemEvent('added', outputIndex, messageItem(itemId, '')),
    {
      type: 'response.content_part.added',
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: textPart(''),
    },
  ]);

export const textDelta = (state: ResponsesSequenceState, outputIndex: number, itemId: string, delta: string) =>
  seq(state, [outputTextEvent('delta', outputIndex, itemId, delta)]);

export const textDone = (state: ResponsesSequenceState, outputIndex: number, itemId: string, text: string, item: ResponsesOutputMessage) =>
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
