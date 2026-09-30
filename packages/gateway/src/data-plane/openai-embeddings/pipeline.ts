import { callOpenAIEmbeddingsUpstream } from './call-upstream.ts';
import { emitOpenAIEmbeddings } from './emit.ts';
import type { Fields } from './facts.ts';
import { narrowing } from './target.ts';
import { isFailure } from '../pipeline/facts.ts';
import { failover } from '../pipeline/failover.ts';
import { resolveCandidates } from '../pipeline/resolve-candidates.ts';
import { writeSettlement } from '../pipeline/settlement.ts';
import { compose, type Pipeline } from '@floway-dev/pipeline';

export const openaiEmbeddingsServePipeline: Pipeline<
  Fields<'ingress.http.headers' | 'ingress.openaiEmbeddings.encodingFormat' | 'request.openaiEmbeddings.canonical' | 'serve.model'>,
  Fields<'response.openaiEmbeddings.rendered' | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'>
> = compose('openaiEmbeddingsServe', [
  writeSettlement(handedUp => Number(handedUp['response.http.status']) >= 400),
  emitOpenAIEmbeddings,
  resolveCandidates(narrowing),
  failover({
    failed: handedUp => isFailure((handedUp as { 'response.openaiEmbeddings.canonical'?: unknown })['response.openaiEmbeddings.canonical']),
    owns: ['response.http.body'],
  }),
  callOpenAIEmbeddingsUpstream,
]);
