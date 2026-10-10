import type { OpenAIResponsesOutputItemEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

export interface OpenAIResponsesOutputOrderState {
  pendingOutputIndexes: Set<number>;
  deferredEvents: OpenAIResponsesStreamEventEx[];
}

export type ShouldTrackOpenAIResponsesOutputItem = (item: OpenAIResponsesOutputItemEx, outputIndex: number) => boolean;

export const createOpenAIResponsesOutputOrderState = (): OpenAIResponsesOutputOrderState => ({
  pendingOutputIndexes: new Set(),
  deferredEvents: [],
});

const getOutputIndex = (event: OpenAIResponsesStreamEventEx): number | undefined => ('output_index' in event && typeof event.output_index === 'number' ? event.output_index : undefined);

// OpenAI Responses can interleave deltas for multiple output items. Downstream OpenAI Chat Completions
// scalar reasoning and Anthropic content blocks are not safely retractable once
// emitted, so visible later-output events wait for earlier tracked items to end.
export const shouldDeferForEarlierOpenAIResponsesOutput = (event: OpenAIResponsesStreamEventEx, state: OpenAIResponsesOutputOrderState): boolean => {
  const outputIndex = getOutputIndex(event);
  if (outputIndex === undefined) return false;

  for (const pendingIndex of state.pendingOutputIndexes) {
    if (pendingIndex < outputIndex) return true;
  }

  return false;
};

type OpenAIResponsesOutputItemAddedEvent = Extract<OpenAIResponsesStreamEventEx, { type: 'response.output_item.added' }>;

type OpenAIResponsesOutputItemDoneEvent = Extract<OpenAIResponsesStreamEventEx, { type: 'response.output_item.done' }>;

const isOutputItemAddedEvent = (event: OpenAIResponsesStreamEventEx): event is OpenAIResponsesOutputItemAddedEvent => event.type === 'response.output_item.added';

const isOutputItemDoneEvent = (event: OpenAIResponsesStreamEventEx): event is OpenAIResponsesOutputItemDoneEvent => event.type === 'response.output_item.done';

export const recordOpenAIResponsesOutputOrderEvent = (event: OpenAIResponsesStreamEventEx, state: OpenAIResponsesOutputOrderState, shouldTrack: ShouldTrackOpenAIResponsesOutputItem): void => {
  if (isOutputItemAddedEvent(event)) {
    if (event.item !== null && shouldTrack(event.item, event.output_index)) {
      state.pendingOutputIndexes.add(event.output_index);
    }
    return;
  }

  if (isOutputItemDoneEvent(event)) {
    state.pendingOutputIndexes.delete(event.output_index);
  }
};
