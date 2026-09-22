import type { OpenAIResponsesOutputImageGenerationCall, OpenAIResponsesStreamEvent } from './index.ts';

export const imageGenerationCallLifecycleEvents = (
  item: OpenAIResponsesOutputImageGenerationCall,
  outputIndex: number,
): {
  startFrames: OpenAIResponsesStreamEvent[];
  endFrames: OpenAIResponsesStreamEvent[];
} => {
  const itemId = item.id;
  const inProgressItem: OpenAIResponsesOutputImageGenerationCall = {
    type: 'image_generation_call',
    id: itemId,
    status: 'in_progress',
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
