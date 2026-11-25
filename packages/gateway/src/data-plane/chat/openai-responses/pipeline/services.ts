import type { GatewayHostServicesInput } from '../../../pipeline/host.ts';
import { createGatewayServices, type GatewayServices } from '../../../pipeline/services.ts';
import type { OpenAIResponsesStatefulStore } from '../items/store.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

type StoreFactory = (startedAt: number, store: boolean | undefined) => OpenAIResponsesStatefulStore;

interface OpenAIResponsesState {
  readonly store: OpenAIResponsesStatefulStore;
  readonly request: CanonicalOpenAIResponsesPayload;
}

export type OpenAIResponsesServices = GatewayServices & {
  readonly requestStartedAt: number;
  readonly openAIResponsesState: (request: CanonicalOpenAIResponsesPayload) => OpenAIResponsesState;
};

export const openAIResponsesServices = (
  input: GatewayHostServicesInput,
  createStore: StoreFactory,
  requestStartedAt: number,
): OpenAIResponsesServices => {
  let state: OpenAIResponsesState | undefined;
  return {
    ...createGatewayServices(input),
    requestStartedAt,
    openAIResponsesState: request => state ??= { request, store: createStore(requestStartedAt, request.store ?? undefined) },
  };
};
