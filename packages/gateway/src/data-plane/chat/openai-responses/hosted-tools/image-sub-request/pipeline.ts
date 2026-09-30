import { emitHostedImageGeneration } from './emit.ts';
import type { ImageSubRequestEntry, ImageSubRequestExit } from './facts.ts';
import { prepareHostedImageGeneration } from './prepare.ts';
import type { ImageGenerationRequest } from './request.ts';
import { retryRateLimitedImages } from './retry.ts';
import { callOpenAIImagesUpstream } from '../../../../openai-images/call-upstream.ts';
import { openaiImagesModelStages } from '../../../../openai-images/pipeline.ts';
import { compose, type Pipeline } from '@floway-dev/pipeline';

export const imageGenerationSubRequestPipeline = (request: ImageGenerationRequest): Pipeline<ImageSubRequestEntry, ImageSubRequestExit> =>
  compose('imageGenerationSubRequest', [
    emitHostedImageGeneration,
    prepareHostedImageGeneration,
    ...openaiImagesModelStages({ operation: request.action === 'edit' ? 'edits' : 'generations' }, [retryRateLimitedImages, callOpenAIImagesUpstream]),
  ]);
