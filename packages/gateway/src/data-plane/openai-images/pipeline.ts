import { callOpenAIImagesUpstream } from './call-upstream.ts';
import { emitOpenAIImages } from './emit.ts';
import type { OpenAIImagesServeEntry, OpenAIImagesServeExit } from './facts.ts';
import { narrowing } from './target.ts';
import { isFailure } from '../pipeline/facts.ts';
import { failover } from '../pipeline/failover.ts';
import { resolveCandidates } from '../pipeline/resolve-candidates.ts';
import { writeSettlement } from '../pipeline/settlement.ts';
import { compose, type Pipeline } from '@floway-dev/pipeline';
import type { CanonicalOpenAIImagesRequest } from '@floway-dev/protocols/openai-images';

export const openaiImagesServePipeline = (request: CanonicalOpenAIImagesRequest): Pipeline<OpenAIImagesServeEntry, OpenAIImagesServeExit> =>
  compose('openaiImagesServe', [
    emitOpenAIImages,
    writeSettlement(
      handedUp => isFailure((handedUp as { 'response.openaiImages.canonical'?: unknown })['response.openaiImages.canonical']),
      handedUp => (handedUp as { 'response.openaiImages.streamedUsage'?: unknown })['response.openaiImages.streamedUsage'] !== null,
    ),
    resolveCandidates(narrowing(request)),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.openaiImages.canonical'?: unknown })['response.openaiImages.canonical']),
      owns: ['response.http.body'],
    }),
    callOpenAIImagesUpstream,
  ]);
