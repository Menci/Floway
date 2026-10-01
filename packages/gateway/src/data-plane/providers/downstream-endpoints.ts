import type { ModelEndpoints } from '@floway-dev/protocols/common';

export const downstreamEndpointsFor = (endpoints: ModelEndpoints): ModelEndpoints => {
  if (endpoints.openaiChatCompletions === undefined && endpoints.openaiResponses === undefined && endpoints.anthropicMessages === undefined) return { ...endpoints };
  return {
    ...endpoints,
    openaiChatCompletions: {},
    openaiResponses: {},
    anthropicMessages: {},
  };
};
