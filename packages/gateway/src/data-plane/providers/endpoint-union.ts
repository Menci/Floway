import type { ModelEndpointKey, ModelEndpoints } from '@floway-dev/protocols/common';

// Union N endpoint maps: a key appears in the result whenever ANY input
// declares it, and its sub-capability flags are OR-ed so a sub-cap
// advertised by any contributor survives. Used at two layers — the catalog
// merge collapses multiple upstream surfaces of the same public id into one
// row, and the alias listing advertises the union across an alias's
// available targets. The request-time pool narrows to whatever subset
// actually serves the inbound endpoint, so every endpoint surfaced through
// the union remains reachable.
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
