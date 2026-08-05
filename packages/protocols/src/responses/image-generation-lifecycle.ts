import type { ResponsesOutputImageGenerationCall, ResponsesStreamEvent } from './index.ts';
import { requireResponsesItemId } from './item-id.ts';

export const imageGenerationCallLifecycleEvents = (
  item: ResponsesOutputImageGenerationCall,
  outputIndex: number,
): {
  startFrames: ResponsesStreamEvent[];
  endFrames: ResponsesStreamEvent[];
} => {
  const itemId = requireResponsesItemId(item);
  const inProgressItem: ResponsesOutputImageGenerationCall = {
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
