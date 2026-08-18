import type * as OpenAIResponses from '@floway-dev/protocols/openai-responses';

type OpenAIResponsesOutputContentBlock = OpenAIResponses.OpenAIResponsesOutputContentBlock;
type OpenAIResponsesOutputCustomToolCall = OpenAIResponses.OpenAIResponsesOutputCustomToolCall;
type OpenAIResponsesOutputFunctionCall = OpenAIResponses.OpenAIResponsesOutputFunctionCall;
type OpenAIResponsesOutputItem = OpenAIResponses.OpenAIResponsesOutputItem;
type OpenAIResponsesOutputMessage = OpenAIResponses.OpenAIResponsesOutputMessage;
type OpenAIResponsesOutputReasoning = OpenAIResponses.OpenAIResponsesOutputReasoning;
type OpenAIResponsesResult = OpenAIResponses.OpenAIResponsesResult;
type OpenAIResponsesStreamEvent = OpenAIResponses.OpenAIResponsesStreamEvent;

export interface OpenAIResponsesSequenceState {
  sequenceNumber: number;
}

type OutputTextPart = Extract<OpenAIResponsesOutputContentBlock, { type: 'output_text' }>;
type RefusalPart = Extract<OpenAIResponsesOutputContentBlock, { type: 'refusal' }>;
type OpenAIResponsesUsage = NonNullable<OpenAIResponsesResult['usage']>;

export const textPart = (text: string, annotations: OpenAIResponses.OpenAIResponsesAnnotation[]): OutputTextPart => ({
  type: 'output_text',
  text,
  annotations,
});

export const refusalPart = (refusal: string): RefusalPart => ({
  type: 'refusal',
  refusal,
});

const summaryPart = (text: string) => ({ type: 'summary_text' as const, text });

const outputItemEvent = (state: 'added' | 'done', outputIndex: number, item: OpenAIResponsesOutputItem): OpenAIResponsesStreamEvent => ({
  type: `response.output_item.${state}`,
  output_index: outputIndex,
  item,
});

const outputTextEvent = (state: 'delta' | 'done', outputIndex: number, itemId: string, text: string): OpenAIResponsesStreamEvent =>
  ({
    type: `response.output_text.${state}`,
    item_id: itemId,
    output_index: outputIndex,
    content_index: 0,
    [state === 'delta' ? 'delta' : 'text']: text,
  } as OpenAIResponsesStreamEvent);

const refusalEvent = (state: 'delta' | 'done', outputIndex: number, itemId: string, refusal: string): OpenAIResponsesStreamEvent =>
  ({
    type: `response.refusal.${state}`,
    item_id: itemId,
    output_index: outputIndex,
    content_index: 0,
    [state === 'delta' ? 'delta' : 'refusal']: refusal,
  } as OpenAIResponsesStreamEvent);

const functionCallArgumentsEvent = (state: 'delta' | 'done', outputIndex: number, itemId: string, text: string): OpenAIResponsesStreamEvent =>
  ({
    type: `response.function_call_arguments.${state}`,
    item_id: itemId,
    output_index: outputIndex,
    [state === 'delta' ? 'delta' : 'arguments']: text,
  } as OpenAIResponsesStreamEvent);

const customToolCallInputEvent = (state: 'delta' | 'done', outputIndex: number, itemId: string, text: string): OpenAIResponsesStreamEvent =>
  ({
    type: `response.custom_tool_call_input.${state}`,
    item_id: itemId,
    output_index: outputIndex,
    [state === 'delta' ? 'delta' : 'input']: text,
  } as OpenAIResponsesStreamEvent);

const reasoningSummaryPartEvent = (state: 'added' | 'done', outputIndex: number, itemId: string, summaryIndex: number, text: string): OpenAIResponsesStreamEvent => ({
  type: `response.reasoning_summary_part.${state}`,
  item_id: itemId,
  output_index: outputIndex,
  summary_index: summaryIndex,
  part: summaryPart(text),
});

const reasoningSummaryTextEvent = (state: 'delta' | 'done', outputIndex: number, itemId: string, summaryIndex: number, text: string): OpenAIResponsesStreamEvent =>
  ({
    type: `response.reasoning_summary_text.${state}`,
    item_id: itemId,
    output_index: outputIndex,
    summary_index: summaryIndex,
    [state === 'delta' ? 'delta' : 'text']: text,
  } as OpenAIResponsesStreamEvent);

export const seq = (state: OpenAIResponsesSequenceState, events: OpenAIResponsesStreamEvent[]): OpenAIResponsesStreamEvent[] =>
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
  output: OpenAIResponsesOutputItem[];
  outputText: string;
  status: OpenAIResponsesResult['status'];
  usage?: OpenAIResponsesUsage;
  incompleteDetails?: OpenAIResponsesResult['incomplete_details'];
  error?: OpenAIResponsesResult['error'];
  serviceTier?: OpenAIResponsesResult['service_tier'];
}): OpenAIResponsesResult => ({
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
export const messageItem = (id: string, status: 'in_progress' | 'completed', part: OpenAIResponsesOutputContentBlock): OpenAIResponsesOutputMessage => ({
  type: 'message',
  id,
  status,
  role: 'assistant',
  content: [part],
});

export const reasoningItem = (id: string, summaryText: string, encryptedContent?: string): OpenAIResponsesOutputReasoning => ({
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
  status: OpenAIResponsesOutputFunctionCall['status'],
  namespace?: string,
): OpenAIResponsesOutputFunctionCall => ({
  type: 'function_call',
  id,
  call_id: callId,
  name,
  ...(namespace !== undefined ? { namespace } : {}),
  arguments: args,
  status,
});

export const customToolCallItem = (id: string, callId: string, name: string, input: string): OpenAIResponsesOutputCustomToolCall => ({
  type: 'custom_tool_call',
  id,
  call_id: callId,
  name,
  input,
});

export const started = (state: OpenAIResponsesSequenceState, response: OpenAIResponsesResult) =>
  seq(state, [
    { type: 'response.created', response },
    {
      type: 'response.in_progress',
      response,
    },
  ]);

export const terminal = (state: OpenAIResponsesSequenceState, response: OpenAIResponsesResult) => {
  let type: 'response.completed' | 'response.incomplete' | 'response.failed';
  switch (response.status) {
  case 'completed': type = 'response.completed'; break;
  case 'incomplete': type = 'response.incomplete'; break;
  case 'failed': type = 'response.failed'; break;
  case 'queued':
  case 'in_progress':
  case 'cancelled':
    throw new TypeError(`Cannot emit a terminal OpenAI Responses event for status '${response.status}'`);
  }
  return seq(state, [
    {
      type,
      response,
    },
  ]);
};

export const itemAdded = (state: OpenAIResponsesSequenceState, outputIndex: number, item: OpenAIResponsesOutputItem) =>
  seq(state, [outputItemEvent('added', outputIndex, item)]);

export const textStart = (state: OpenAIResponsesSequenceState, outputIndex: number, itemId: string) => {
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

export const textDelta = (state: OpenAIResponsesSequenceState, outputIndex: number, itemId: string, delta: string) =>
  seq(state, [outputTextEvent('delta', outputIndex, itemId, delta)]);

export const textDone = (state: OpenAIResponsesSequenceState, outputIndex: number, itemId: string, part: OutputTextPart, item: OpenAIResponsesOutputMessage) =>
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

export const refusalStart = (state: OpenAIResponsesSequenceState, outputIndex: number, itemId: string) => {
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

export const refusalDelta = (state: OpenAIResponsesSequenceState, outputIndex: number, itemId: string, delta: string) =>
  seq(state, [refusalEvent('delta', outputIndex, itemId, delta)]);

export const refusalDone = (state: OpenAIResponsesSequenceState, outputIndex: number, itemId: string, part: RefusalPart, item: OpenAIResponsesOutputMessage) =>
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

export const argumentsDelta = (state: OpenAIResponsesSequenceState, outputIndex: number, itemId: string, delta: string) =>
  seq(state, [functionCallArgumentsEvent('delta', outputIndex, itemId, delta)]);

export const functionCallDone = (state: OpenAIResponsesSequenceState, outputIndex: number, itemId: string, args: string, item: OpenAIResponsesOutputFunctionCall) =>
  seq(state, [functionCallArgumentsEvent('done', outputIndex, itemId, args), outputItemEvent('done', outputIndex, item)]);

export const customToolCallDone = (state: OpenAIResponsesSequenceState, outputIndex: number, itemId: string, input: string, item: OpenAIResponsesOutputCustomToolCall) =>
  seq(state, [
    ...(input.length > 0 ? [customToolCallInputEvent('delta', outputIndex, itemId, input)] : []),
    customToolCallInputEvent('done', outputIndex, itemId, input),
    outputItemEvent('done', outputIndex, item),
  ]);

export const reasoningStart = (state: OpenAIResponsesSequenceState, outputIndex: number, itemId: string) =>
  seq(state, [outputItemEvent('added', outputIndex, reasoningItem(itemId, '')), reasoningSummaryPartEvent('added', outputIndex, itemId, 0, '')]);

export const reasoningDelta = (state: OpenAIResponsesSequenceState, outputIndex: number, itemId: string, delta: string) =>
  seq(state, [reasoningSummaryTextEvent('delta', outputIndex, itemId, 0, delta)]);

export const reasoningDone = (state: OpenAIResponsesSequenceState, outputIndex: number, itemId: string, summaryText: string, item: OpenAIResponsesOutputReasoning) =>
  seq(state, [
    ...(summaryText ? [reasoningSummaryTextEvent('done', outputIndex, itemId, 0, summaryText)] : []),
    reasoningSummaryPartEvent('done', outputIndex, itemId, 0, summaryText),
    outputItemEvent('done', outputIndex, item),
  ]);

export const completedReasoning = (state: OpenAIResponsesSequenceState, outputIndex: number, item: OpenAIResponsesOutputReasoning) =>
  seq(state, [
    outputItemEvent('added', outputIndex, item),
    ...item.summary.flatMap((part, summaryIndex) => [
      reasoningSummaryPartEvent('added', outputIndex, item.id, summaryIndex, part.text),
      reasoningSummaryTextEvent('done', outputIndex, item.id, summaryIndex, part.text),
      reasoningSummaryPartEvent('done', outputIndex, item.id, summaryIndex, part.text),
    ]),
    outputItemEvent('done', outputIndex, item),
  ]);
