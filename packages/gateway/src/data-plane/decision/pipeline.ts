import { callDecisionUpstream } from './call-upstream.ts';
import { emitDecision } from './emit.ts';
import type { Fields } from './facts.ts';
import { narrowing } from './target.ts';
import { isFailure } from '../pipeline/facts.ts';
import { failover } from '../pipeline/failover.ts';
import { resolveCandidates } from '../pipeline/resolve-candidates.ts';
import { serializeClientJson } from '../pipeline/serialize-client-json.ts';
import { writeSettlement } from '../pipeline/settlement.ts';
import { compose, type Pipeline } from '@floway-dev/pipeline';

export const decisionServePipeline: Pipeline<
  Fields<'ingress.http.headers' | 'ingress.decision.sourceProtocol' | 'request.decision.canonical' | 'serve.model'>,
  Fields<'response.http.jsonBody' | 'response.decision.rendered' | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'>
> = compose('decisionServe', [
  writeSettlement(handedUp => Number(handedUp['response.http.status']) >= 400),
  serializeClientJson('response.decision.rendered'),
  emitDecision,
  resolveCandidates(narrowing),
  failover({
    failed: handedUp => isFailure((handedUp as { 'response.decision.answer'?: unknown })['response.decision.answer']),
    owns: ['response.http.body'],
  }),
  callDecisionUpstream,
]);
