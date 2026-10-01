import { callOpenAIImagesUpstream } from './call-upstream.ts';
import { emitOpenAIImages } from './emit.ts';
import type { OpenAIImagesServeEntry, OpenAIImagesServeExit } from './facts.ts';
import { narrowing } from './target.ts';
import { isFailure } from '../pipeline/facts.ts';
import { failover } from '../pipeline/failover.ts';
import { resolveCandidates } from '../pipeline/resolve-candidates.ts';
import { serializeClientJson } from '../pipeline/serialize-client-json.ts';
import { writeSettlement } from '../pipeline/settlement.ts';
import { compose, type Pipeline, type Stage } from '@floway-dev/pipeline';
import type { CanonicalOpenAIImagesRequest } from '@floway-dev/protocols/openai-images';

export const openaiImagesServePipeline = (request: CanonicalOpenAIImagesRequest): Pipeline<OpenAIImagesServeEntry, OpenAIImagesServeExit> =>
  compose('openaiImagesServe', [
    writeSettlement(handedUp => Number(handedUp['response.http.status']) >= 400, 'response.openaiImages.streamedUsage'),
    serializeClientJson('response.openaiImages.rendered'),
    emitOpenAIImages,
    ...openaiImagesModelStages(request),
  ]);

export const openaiImagesModelStages = (request: Pick<CanonicalOpenAIImagesRequest, 'operation'>, dispatchStages: readonly Stage[] = [callOpenAIImagesUpstream]): readonly Stage[] => [
  resolveCandidates(narrowing(request)),
  failover({
    failed: handedUp => isFailure((handedUp as { 'response.openaiImages.canonical'?: unknown })['response.openaiImages.canonical']),
    owns: ['response.http.body'],
    pendingUsage: 'response.openaiImages.streamedUsage',
  }),
  ...dispatchStages,
];
