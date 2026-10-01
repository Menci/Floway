import type { ModelEndpointKey, ModelEndpoints } from '@floway-dev/protocols/common';

// Aggregate native availability for routing; compatibility stays provider-local.
export const unionEndpoints = (endpointsList: readonly ModelEndpoints[]): ModelEndpoints => {
  const result: ModelEndpoints = {};
  for (const endpoints of endpointsList) {
    for (const key of Object.keys(endpoints) as ModelEndpointKey[]) {
      if (endpoints[key] !== undefined) result[key] = {};
    }
  }
  return result;
};
