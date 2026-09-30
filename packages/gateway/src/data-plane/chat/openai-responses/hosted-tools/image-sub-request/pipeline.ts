import { dialImageGeneration } from './dial.ts';
import type { Fields } from './facts.ts';
import { writeSettlement } from '../../../../pipeline/settlement.ts';
import { compose, type Pipeline } from '@floway-dev/pipeline';

export const imageGenerationSubRequestPipeline: Pipeline<
  Fields<'request.imageGeneration.action'>,
  Fields<'response.imageGeneration.lifecycle' | 'response.imageGeneration.streamedUsage'>
> = compose('imageGenerationSubRequest', [
  writeSettlement(
    () => false,
    handedUp => (handedUp as { 'response.imageGeneration.streamedUsage'?: unknown })['response.imageGeneration.streamedUsage'] !== null,
  ),
  dialImageGeneration,
]);
