import type { OpenAIResponsesOutputItem, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

export interface OpenAIResponsesOutputOrderState {
  pendingOutputIndexes: Set<number>;
  deferredEvents: OpenAIResponsesStreamEvent[];
}

export type ShouldTrackOpenAIResponsesOutputItem = (item: OpenAIResponsesOutputItem, outputIndex: number) => boolean;

export const createOpenAIResponsesOutputOrderState = (): OpenAIResponsesOutputOrderState => ({
  pendingOutputIndexes: new Set(),
  deferredEvents: [],
});

const getOutputIndex = (event: OpenAIResponsesStreamEvent): number | undefined => ('output_index' in event && typeof event.output_index === 'number' ? event.output_index : undefined);

// OpenAI Responses can interleave deltas for multiple output items. Downstream Chat
// scalar reasoning and Anthropic content blocks are not safely retractable once
// emitted, so visible later-output events wait for earlier tracked items to end.
export const shouldDeferForEarlierOpenAIResponsesOutput = (event: OpenAIResponsesStreamEvent, state: OpenAIResponsesOutputOrderState): boolean => {
  const outputIndex = getOutputIndex(event);
  if (outputIndex === undefined) return false;

  for (const pendingIndex of state.pendingOutputIndexes) {
    if (pendingIndex < outputIndex) return true;
  }

  return false;
};

type OpenAIResponsesOutputItemAddedEvent = Extract<OpenAIResponsesStreamEvent, { type: 'response.output_item.added' }>;

type OpenAIResponsesOutputItemDoneEvent = Extract<OpenAIResponsesStreamEvent, { type: 'response.output_item.done' }>;

const isOutputItemAddedEvent = (event: OpenAIResponsesStreamEvent): event is OpenAIResponsesOutputItemAddedEvent => event.type === 'response.output_item.added';

const isOutputItemDoneEvent = (event: OpenAIResponsesStreamEvent): event is OpenAIResponsesOutputItemDoneEvent => event.type === 'response.output_item.done';

export const recordOpenAIResponsesOutputOrderEvent = (event: OpenAIResponsesStreamEvent, state: OpenAIResponsesOutputOrderState, shouldTrack: ShouldTrackOpenAIResponsesOutputItem): void => {
  if (isOutputItemAddedEvent(event)) {
    if (shouldTrack(event.item, event.output_index)) {
      state.pendingOutputIndexes.add(event.output_index);
    }
    return;
  }

  if (isOutputItemDoneEvent(event)) {
    state.pendingOutputIndexes.delete(event.output_index);
  }
};
