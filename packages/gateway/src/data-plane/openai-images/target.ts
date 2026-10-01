import type { Failure } from '../pipeline/facts.ts';
import type { ModelEndpointKey } from '@floway-dev/protocols/common';
import type { OpenAIImagesOperation, CanonicalOpenAIImagesRequest } from '@floway-dev/protocols/openai-images';
import type { ModelCandidate } from '@floway-dev/provider';

const ENDPOINT = {
  generations: 'openaiImagesGenerations',
  edits: 'openaiImagesEdits',
} as const satisfies Record<OpenAIImagesOperation, ModelEndpointKey>;

/** A candidate that cannot serve *this* request is not a candidate. One family covers two
 *  endpoints and an upstream may expose either without the other, so which one is asked for is
 *  what narrows the list. */
export const narrowing = (request: Pick<CanonicalOpenAIImagesRequest, 'operation'>) => ({
  kind: 'image' as const,
  reject: (candidate: ModelCandidate) => candidate.model.endpoints[ENDPOINT[request.operation]] === undefined
    ? `the upstream does not expose the OpenAI Images ${request.operation} endpoint`
    : null,
  unsupported: (model: string) => `Model ${model} does not support the /images/${request.operation} endpoint.`,
  refuse: (status: number, message: string) => ({
    'response.openaiImages.canonical': { status, message } as Failure,
    'response.openaiImages.streamedUsage': null,
  }),
  refuses: ['response.openaiImages.canonical', 'response.openaiImages.streamedUsage'] as const,
});
