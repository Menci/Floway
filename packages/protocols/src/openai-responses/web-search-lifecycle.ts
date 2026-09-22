import type { OpenAIResponsesOutputWebSearchCall, OpenAIResponsesStreamEvent } from './index.ts';

// Hosted `web_search` lifecycle on OpenAI Responses: 5 events at one output_index.
//
//   1. response.output_item.added            { item: web_search_call, status: 'in_progress', action }
//   2. response.web_search_call.in_progress  { item_id }
//   3. response.web_search_call.searching    { item_id }
//   4. response.web_search_call.completed    { item_id }
//   5. response.output_item.done             { item: completed item with action + results }
//
// Returned as `startFrames` / `endFrames` so callers awaiting a backend
// between `searching` and `completed` can emit each half independently.
// Sequence numbers are NOT assigned here.
//
// The `output_item.added` item carries `action` (with `status:
// 'in_progress'` and no `results`) so typed SDKs (openai-python's
// `ResponseFunctionWebSearch.action` is declared required, not
// `Optional`) parse the start frame the same way they parse the
// end frame. Native upstreams omit `action` on `.added` and only
// populate it on `.done`; the shim diverges here because it always
// knows the action at start time (the shim's parsed arguments
// produce the action shape before any backend work).
//   https://github.com/openai/openai-python/blob/HEAD/src/openai/types/responses/response_function_web_search.py

export const webSearchCallLifecycleEvents = (
  item: OpenAIResponsesOutputWebSearchCall,
  outputIndex: number,
): {
  startFrames: OpenAIResponsesStreamEvent[];
  endFrames: OpenAIResponsesStreamEvent[];
} => {
  const itemId = item.id;
  const inProgressItem: OpenAIResponsesOutputWebSearchCall = {
    type: 'web_search_call',
    id: itemId,
    status: 'in_progress',
    ...(item.action !== undefined ? { action: item.action } : {}),
  };
  return {
    startFrames: [
      {
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: inProgressItem,
      },
      { type: 'response.web_search_call.in_progress', output_index: outputIndex, item_id: itemId },
      { type: 'response.web_search_call.searching', output_index: outputIndex, item_id: itemId },
    ],
    endFrames: [
      { type: 'response.web_search_call.completed', output_index: outputIndex, item_id: itemId },
      { type: 'response.output_item.done', output_index: outputIndex, item },
    ],
  };
};
