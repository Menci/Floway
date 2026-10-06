import type { OpenAIResponsesOutputImageGenerationCallEx, OpenAIResponsesStreamEventEx } from './index.ts';

export const imageGenerationCallLifecycleEvents = (
  item: OpenAIResponsesOutputImageGenerationCallEx,
  outputIndex: number,
): {
  startFrames: OpenAIResponsesStreamEventEx[];
  endFrames: OpenAIResponsesStreamEventEx[];
} => {
  const itemId = item.id;
  const inProgressItem: OpenAIResponsesOutputImageGenerationCallEx = {
    type: 'image_generation_call',
    id: itemId,
    status: 'in_progress',
    result: null,
  };
  return {
    startFrames: [
      { type: 'response.output_item.added', output_index: outputIndex, item: inProgressItem },
      { type: 'response.image_generation_call.in_progress', output_index: outputIndex, item_id: itemId },
      { type: 'response.image_generation_call.generating', output_index: outputIndex, item_id: itemId },
    ],
    endFrames: [
      ...(item.status === 'completed'
        ? [{ type: 'response.image_generation_call.completed' as const, output_index: outputIndex, item_id: itemId }]
        : []),
      { type: 'response.output_item.done', output_index: outputIndex, item },
    ],
  };
};
