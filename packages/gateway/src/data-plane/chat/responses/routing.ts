import { classifyResponsesItemAffinity } from './items/affinity.ts';
import type { RoutingDecision } from '../shared/routing.ts';
import type { StatefulResponsesStore } from './items/store.ts';
import type { ResponsesInputItem, ResponsesPayload } from '@floway-dev/protocols/responses';
import type { ProviderCandidate } from '@floway-dev/provider';
import { responsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export const planResponsesRouting = async (input: {
  readonly payload: ResponsesPayload;
  readonly candidates: readonly ProviderCandidate[];
  readonly store: StatefulResponsesStore;
}): Promise<RoutingDecision> => {
  // A bare-string input is wrapped into a synthetic user message for staging;
  // the affinity walk receives an empty item array since strings carry no
  // item references to resolve.
  const { sourceItems, inputItemsToStage }: {
    sourceItems: readonly ResponsesInputItem[];
    inputItemsToStage: readonly ResponsesInputItem[];
  } = typeof input.payload.input === 'string'
    ? { sourceItems: [], inputItemsToStage: [{ type: 'message', role: 'user', content: input.payload.input }] }
    : { sourceItems: input.payload.input, inputItemsToStage: input.payload.input };
  return await classifyResponsesItemAffinity({
    sourceItems,
    view: responsesItemsView,
    store: input.store,
    candidates: input.candidates,
    inputItemsToStage,
  });
};
