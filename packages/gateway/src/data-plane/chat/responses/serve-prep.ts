import { prepareResponsesAffinity } from './affinity/ingress.ts';
import { responsesTarget } from './attempt.ts';
import { renderResponsesFailure } from './errors.ts';
import { hydrateResponsesPayload } from './items/rewrite.ts';
import type { StatefulResponsesStore } from './items/store.ts';
import { enumerateModelCandidates } from '../../providers/registry.ts';
import { type PreparedAffinityPayload, routeCandidatesByAffinity } from '../shared/affinity/index.ts';
import { noViableCandidateFailure, tryCatchChatServeFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ModelCandidate, ExecuteResult } from '@floway-dev/provider';

// Thrown when a request names a `previous_response_id` that the store cannot
// resolve. The HTTP/WS entry layer catches this and renders the OpenAI-shaped
// 400 body verbatim — clients (codex) compare it byte-for-byte against
// upstream OpenAI's `previous_response_not_found` envelope, so the rendering
// stays at the entry boundary instead of being folded into the generic
// ChatServeFailure renderer.
//
// Verbatim payload cross-verified from real upstream captures:
// - https://github.com/cline/cline/issues/9399
// - https://github.com/microsoft/semantic-kernel/issues/13128
// - https://github.com/router-for-me/CLIProxyAPI/issues/999
// - https://github.com/openai/openai-agents-python/issues/2020
export class PreviousResponseNotFoundError extends Error {
  readonly previousResponseId: string;

  constructor(previousResponseId: string) {
    super(`Previous response with id '${previousResponseId}' not found.`);
    this.name = 'PreviousResponseNotFoundError';
    this.previousResponseId = previousResponseId;
  }
}

// Stitches a previous turn's snapshot items in front of this turn's input,
// then drops `previous_response_id` from the payload (the snapshot id is a
// gateway concept and never reaches the upstream wire). Native-entry only:
// translated payloads coming in from another protocol's attempt never carry
// `previous_response_id`, so this prep runs in serve and not in attempt.
export const expandPreviousResponseId = async (
  payload: CanonicalResponsesPayload,
  store: StatefulResponsesStore,
): Promise<CanonicalResponsesPayload> => {
  const previousResponseId = payload.previous_response_id;
  if (previousResponseId === undefined || previousResponseId === null) return payload;

  const snapshot = await store.loadSnapshot(previousResponseId);
  if (snapshot === null) throw new PreviousResponseNotFoundError(previousResponseId);

  const { previous_response_id: _previous, ...rest } = payload;
  return {
    ...rest,
    input: [
      ...snapshot.itemIds.map(id => ({ type: 'item_reference' as const, id })),
      ...payload.input,
    ],
  };
};

export type ResponsesServePlan =
  | { readonly kind: 'failure'; readonly result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> }
  | {
    readonly kind: 'ready';
    readonly affinity: PreparedAffinityPayload<CanonicalResponsesPayload>;
    readonly privatePayloads: ReadonlyMap<string, unknown>;
    readonly candidates: readonly ModelCandidate[];
  };

// Runs the native source preparation both `responsesServe.generate` and
// `responsesServe.compact` need before dispatching to `responsesAttempt`:
// expand any `previous_response_id`, load and hydrate stored items, prepare
// affinity, stage the user input, and return the narrowed candidate list.
// Returns a rendered failure result when no candidate is viable so the
// caller can surface it directly without re-deriving the model-error
// branch. The caller iterates the candidates — a successful attempt is the
// final answer, a per-candidate failure falls through to the next entry.
export const prepareResponsesServePlan = async (args: {
  readonly payload: CanonicalResponsesPayload;
  readonly ctx: ChatGatewayCtx;
}): Promise<ResponsesServePlan> => {
  const { payload, ctx } = args;
  const store = ctx.store;
  if (store === undefined) throw new Error('Native Responses serve requires a state store');
  const prepared = await expandPreviousResponseId(payload, store);
  const { candidates, sawModel, failedUpstreams } = await enumerateModelCandidates({
    upstreamIds: ctx.upstreamIds,
    model: prepared.model,
    kind: 'chat',
    scheduler: ctx.backgroundScheduler,
    runtimeLocation: ctx.runtimeLocation,
  });
  const viable = candidates.filter(c => responsesTarget.canServe(c.model.endpoints));
  await store.loadInputItems(prepared.input, payload.input);
  let hydrated: ReturnType<typeof hydrateResponsesPayload>;
  try {
    hydrated = hydrateResponsesPayload(prepared, store);
  } catch (error) {
    const failure = tryCatchChatServeFailure(error);
    if (failure === null) throw error;
    return { kind: 'failure', result: renderResponsesFailure(failure) };
  }
  const affinity = await prepareResponsesAffinity(hydrated.payload, ctx.affinity.codec);
  const decision = routeCandidatesByAffinity(viable, affinity.routingEvidence);
  if (decision.kind === 'failure') return { kind: 'failure', result: renderResponsesFailure(decision.failure) };
  // Stage the user-supplied input from the original payload — not the
  // expansion's `item_reference` prefix — so the next-turn snapshot picks
  // up the new user items in addition to the prior snapshot history.
  // Runs after the affinity walk so any `item_reference` in user-supplied
  // input has its target row loaded.
  await store.stageInputItems(payload.input);

  if (decision.candidates.length === 0) {
    return {
      kind: 'failure',
      result: renderResponsesFailure(noViableCandidateFailure(sawModel, prepared.model, failedUpstreams)),
    };
  }
  return { kind: 'ready', affinity, privatePayloads: hydrated.privatePayloads, candidates: decision.candidates };
};
