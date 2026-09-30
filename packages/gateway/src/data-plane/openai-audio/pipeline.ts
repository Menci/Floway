import { callOpenAIAudioTranscriptionUpstream } from './call-upstream.ts';
import { emitOpenAIAudioTranscription } from './emit.ts';
import type { Fields } from './facts.ts';
import { narrowing } from './target.ts';
import { isFailure, type BillableEntity } from '../pipeline/facts.ts';
import { failover } from '../pipeline/failover.ts';
import { resolveCandidates } from '../pipeline/resolve-candidates.ts';
import { writeSettlement } from '../pipeline/settlement.ts';
import { compose, type Pipeline } from '@floway-dev/pipeline';

export const openaiAudioTranscriptionServePipeline: Pipeline<
  Fields<'ingress.http.headers' | 'ingress.openaiAudioTranscription.responseFormat' | 'request.openaiAudioTranscription.form' | 'serve.model'>,
  Fields<'response.openaiAudioTranscription.rendered' | 'response.openaiAudioTranscription.mediaType' | 'response.openaiAudioTranscription.streamedOutcome'>
  & { 'response.http.status': number; 'response.usage.billable': readonly BillableEntity[];
    'response.http.headers': readonly (readonly [string, string])[]; }
> = compose('openaiAudioTranscriptionServe', [
  emitOpenAIAudioTranscription,
  writeSettlement(
    handedUp => isFailure((handedUp as { 'response.openaiAudioTranscription.canonical'?: unknown })['response.openaiAudioTranscription.canonical']),
    handedUp => (handedUp as { 'response.openaiAudioTranscription.streamedOutcome'?: unknown })['response.openaiAudioTranscription.streamedOutcome'] !== null,
  ),
  resolveCandidates(narrowing),
  failover({
    failed: handedUp => isFailure((handedUp as { 'response.openaiAudioTranscription.canonical'?: unknown })['response.openaiAudioTranscription.canonical']),
    owns: ['response.http.body'],
  }),
  callOpenAIAudioTranscriptionUpstream,
]);
