import type { ModelEndpointKey, ModelEndpoints } from '@floway-dev/protocols/common';

// Aggregate native availability for routing. Endpoint options are meaningful
// only on the selected provider model; public metadata uses downstreamEndpoints.
export const unionEndpoints = (endpointsList: readonly ModelEndpoints[]): ModelEndpoints => {
  const result: ModelEndpoints = {};
  for (const endpoints of endpointsList) {
    for (const key of Object.keys(endpoints) as ModelEndpointKey[]) {
      const incoming = endpoints[key];
      if (incoming === undefined) continue;
      result[key] = { ...result[key], ...incoming };
    }
  }
  return result;
};
