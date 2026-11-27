import { anthropicMessagesCountTokensTargets } from './provider-anthropic-messages.ts';
import { geminiGenerateContentCountTokensTargets } from './provider-gemini-generate-content.ts';
import { selectAffinityCandidates, type AffinityCandidate, type AffinityRequestAnalysis } from '../../chat/shared/affinity/selection.ts';
import type { Candidate } from '../../pipeline/facts.ts';

export const supportsAnthropicMessagesCountTokens = ({ model, upstream }: Candidate): boolean =>
  model.endpoints.anthropicMessages !== undefined && Object.hasOwn(anthropicMessagesCountTokensTargets, upstream.kind);

export const supportsNativeGeminiGenerateContentCountTokens = ({ model, upstream }: Candidate): boolean =>
  model.endpoints.geminiGenerateContent !== undefined && Object.hasOwn(geminiGenerateContentCountTokensTargets, upstream.kind);

export const selectCountTokensCandidates = <Payload>(candidates: readonly Candidate[], affinity: AffinityRequestAnalysis<Payload, AffinityCandidate>) => {
  const adapted = candidates.map(candidate => ({
    candidate,
    upstream: { upstreamId: candidate.upstream.id },
    model: candidate.model,
    ...(candidate.rules === undefined ? {} : { rules: candidate.rules }),
  }));
  const selection = selectAffinityCandidates(adapted, affinity);
  if ('kind' in selection) return selection;
  return selection.candidates.map(item => ({ ...item.candidate, payload: selection.payloadFor(item) }));
};
