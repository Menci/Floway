import { classifyResponsesItemAffinity } from '../responses/items/affinity.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import type { RoutingDecision } from '../shared/routing.ts';
import type { GeminiPayload } from '@floway-dev/protocols/gemini';
import type { ProviderCandidate } from '@floway-dev/provider';
import { geminiViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export type GeminiRoutingDecision = RoutingDecision;

export const planGeminiRouting = async (input: {
  readonly payload: GeminiPayload;
  readonly candidates: readonly ProviderCandidate[];
  readonly store: StatefulResponsesStore;
}): Promise<GeminiRoutingDecision> =>
  await classifyResponsesItemAffinity({
    sourceItems: input.payload.contents ?? [],
    view: geminiViaResponsesItemsView,
    store: input.store,
    candidates: input.candidates,
  });
