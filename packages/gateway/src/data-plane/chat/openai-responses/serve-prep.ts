import { analyzeOpenAIResponsesAffinity } from './affinity/ingress.ts';
import { openaiResponsesTarget } from './attempt.ts';
import { renderOpenAIResponsesFailure, type OpenAIResponsesServeFailure } from './errors.ts';
import { hydrateOpenAIResponsesPayload } from './items/hydrate.ts';
import { expandPreviousResponseId } from './items/previous-response.ts';
import { enumerateModelCandidates } from '../../providers/resolution.ts';
import type { AffinityCandidateSelection } from '../shared/affinity/index.ts';
import { selectAffinityCandidates } from '../shared/affinity/index.ts';
import { noViableCandidateFailure, tryCatchChatServeFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ModelCandidate, ExecuteResult } from '@floway-dev/provider';

export { expandPreviousResponseId, PreviousResponseNotFoundError } from './items/previous-response.ts';

export type OpenAIResponsesServePlan =
  | { readonly kind: 'failure'; readonly result: ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEventEx>> }
  | {
    readonly kind: 'ready';
    readonly affinitySelection: AffinityCandidateSelection<CanonicalOpenAIResponsesPayload>;
    readonly candidates: readonly ModelCandidate[];
  };

// Runs the native source preparation both `openaiResponsesServe.generate` and
// `openaiResponsesServe.compact` need before dispatching to `openaiResponsesAttempt`:
// expand any `previous_response_id`, load and hydrate stored items, prepare
// affinity, stage the user input, and return the selected candidate list.
// Returns a rendered failure result when no candidate is viable so the
// caller can surface it directly without re-deriving the model-error
// branch. The caller iterates the candidates — a successful attempt is the
// final answer, a per-candidate failure falls through to the next entry.
export const prepareOpenAIResponsesServePlan = async (args: {
  readonly payload: CanonicalOpenAIResponsesPayload;
  readonly ctx: ChatGatewayCtx;
}): Promise<OpenAIResponsesServePlan> => {
  const { payload, ctx } = args;
  const store = ctx.store;
  const prepared = await expandPreviousResponseId(payload, store);
  const { candidates, sawModel, failedUpstreams } = await enumerateModelCandidates({
    subject: ctx.user,
    upstreamIds: ctx.upstreamIds,
    randomizeUpstreams: ctx.randomizeUpstreams,
    model: prepared.model,
    kind: 'chat',
    scheduler: ctx.backgroundScheduler,
    runtimeLocation: ctx.runtimeLocation,
  });
  const viable = candidates.filter(c => openaiResponsesTarget.canServe(c.model.endpoints));
  await store.loadInputItems(prepared.input, payload.input);
  let hydrated: ReturnType<typeof hydrateOpenAIResponsesPayload>;
  try {
    hydrated = hydrateOpenAIResponsesPayload(prepared, store);
  } catch (error) {
    const failure = tryCatchChatServeFailure<OpenAIResponsesServeFailure>(error);
    if (failure === null) throw error;
    return { kind: 'failure', result: renderOpenAIResponsesFailure(failure) };
  }
  const affinity = await analyzeOpenAIResponsesAffinity(hydrated, ctx.affinity.codec);
  const selection = selectAffinityCandidates(viable, affinity);
  if ('kind' in selection) return { kind: 'failure', result: renderOpenAIResponsesFailure(selection) };
  // Stage the user-supplied input from the original payload — not the
  // expansion's `item_reference` prefix — so the next-turn snapshot picks
  // up the new user items in addition to the prior snapshot history.
  // Runs after the affinity walk so any `item_reference` in user-supplied
  // input has its target row loaded.
  await store.stageInputItems(payload.input);

  if (selection.candidates.length === 0) {
    return {
      kind: 'failure',
      result: renderOpenAIResponsesFailure(noViableCandidateFailure(sawModel, prepared.model, failedUpstreams)),
    };
  }
  return { kind: 'ready', affinitySelection: selection, candidates: selection.candidates };
};
