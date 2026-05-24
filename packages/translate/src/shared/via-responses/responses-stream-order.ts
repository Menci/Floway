import type { ResponseOutputItem, ResponseStreamEvent } from '@floway-dev/protocols/responses';

export interface ResponsesOutputOrderState {
  pendingOutputIndexes: Set<number>;
  deferredEvents: ResponseStreamEvent[];
}

export type ShouldTrackResponseOutputItem = (item: ResponseOutputItem, outputIndex: number) => boolean;

export const createResponsesOutputOrderState = (): ResponsesOutputOrderState => ({
  pendingOutputIndexes: new Set(),
  deferredEvents: [],
});

const getOutputIndex = (event: ResponseStreamEvent): number | undefined => ('output_index' in event && typeof event.output_index === 'number' ? event.output_index : undefined);

// Responses can interleave deltas for multiple output items. Downstream Chat
// scalar reasoning and Anthropic content blocks are not safely retractable once
// emitted, so visible later-output events wait for earlier tracked items to end.
export const shouldDeferForEarlierResponseOutput = (event: ResponseStreamEvent, state: ResponsesOutputOrderState): boolean => {
  const outputIndex = getOutputIndex(event);
  if (outputIndex === undefined) return false;

  for (const pendingIndex of state.pendingOutputIndexes) {
    if (pendingIndex < outputIndex) return true;
  }

  return false;
};

type ResponseOutputItemAddedEvent = Extract<ResponseStreamEvent, { type: 'response.output_item.added' }>;

type ResponseOutputItemDoneEvent = Extract<ResponseStreamEvent, { type: 'response.output_item.done' }>;

const isOutputItemAddedEvent = (event: ResponseStreamEvent): event is ResponseOutputItemAddedEvent => event.type === 'response.output_item.added';

const isOutputItemDoneEvent = (event: ResponseStreamEvent): event is ResponseOutputItemDoneEvent => event.type === 'response.output_item.done';

export const recordResponseOutputOrderEvent = (event: ResponseStreamEvent, state: ResponsesOutputOrderState, shouldTrack: ShouldTrackResponseOutputItem): void => {
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
