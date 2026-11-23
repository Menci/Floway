import { responsesPayloadStage } from './facts.ts';

export const forceStoreFalse = responsesPayloadStage('forceStoreFalse', (payload, facts) =>
  facts['route.candidate'].providerModel.enabledFlags.includes('openai-responses-store-false')
    ? { ...payload, store: false }
    : payload);
