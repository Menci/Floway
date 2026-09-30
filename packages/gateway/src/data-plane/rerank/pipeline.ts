import { callRerankUpstream } from './call-upstream.ts';
import { emitRerank } from './emit.ts';
import type { Fields } from './facts.ts';
import { narrowing } from './target.ts';
import { isFailure } from '../pipeline/facts.ts';
import { failover } from '../pipeline/failover.ts';
import { resolveCandidates } from '../pipeline/resolve-candidates.ts';
import { serializeClientJson } from '../pipeline/serialize-client-json.ts';
import { writeSettlement } from '../pipeline/settlement.ts';
import { compose, type Pipeline } from '@floway-dev/pipeline';
import type { CanonicalRerankRequest } from '@floway-dev/protocols/rerank';

export const rerankServePipeline = (request: CanonicalRerankRequest): Pipeline<
  Fields<'ingress.http.headers' | 'ingress.rerank.sourceProtocol' | 'request.rerank.canonical' | 'serve.model'>,
  Fields<'response.http.jsonBody' | 'response.rerank.rendered' | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'>
> => compose('rerankServe', [
  writeSettlement(handedUp => Number(handedUp['response.http.status']) >= 400),
  serializeClientJson('response.rerank.rendered'),
  emitRerank,
  resolveCandidates(narrowing(request)),
  failover({
    failed: handedUp => isFailure((handedUp as { 'response.rerank.canonical'?: unknown })['response.rerank.canonical']),
    owns: ['response.http.body'],
  }),
  callRerankUpstream,
]);
