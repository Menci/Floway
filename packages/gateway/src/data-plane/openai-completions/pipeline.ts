import { callOpenAICompletionsUpstream } from './call-upstream.ts';
import { emitOpenAICompletions } from './emit.ts';
import type { Fields } from './facts.ts';
import { narrowing } from './target.ts';
import { isFailure } from '../pipeline/facts.ts';
import { failover } from '../pipeline/failover.ts';
import { resolveCandidates } from '../pipeline/resolve-candidates.ts';
import { writeSettlement } from '../pipeline/settlement.ts';
import { compose, type Pipeline } from '@floway-dev/pipeline';

export const openaiCompletionsServePipeline: Pipeline<
  Fields<'ingress.http.headers' | 'ingress.openaiCompletions.wantsStream' | 'ingress.openaiCompletions.wantsUsageChunk' | 'request.openaiCompletions.payload' | 'serve.model'>,
  Fields<'response.openaiCompletions.rendered' | 'response.openaiCompletions.streamedUsage' | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'>
> = compose('openaiCompletionsServe', [
  emitOpenAICompletions,
  writeSettlement(
    handedUp => isFailure((handedUp as { 'response.openaiCompletions.payload'?: unknown })['response.openaiCompletions.payload']),
    handedUp => (handedUp as { 'response.openaiCompletions.streamedUsage'?: unknown })['response.openaiCompletions.streamedUsage'] !== null,
  ),
  resolveCandidates(narrowing),
  failover({
    failed: handedUp => isFailure((handedUp as { 'response.openaiCompletions.payload'?: unknown })['response.openaiCompletions.payload']),
    owns: ['response.http.body'],
  }),
  callOpenAICompletionsUpstream,
]);
