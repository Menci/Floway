import type { ModelEndpointKey, ModelEndpoints } from '@floway-dev/protocols/common';

// Merge N endpoint maps. For each repeated key, shallow-spread the prior and
// incoming sub-capabilities, so colliding fields are last-wins. Those objects
// are empty today, making this equivalent to a union by key presence; future
// non-empty shapes require an explicit merge policy. Used at two layers — the
// catalog merge collapses multiple upstream surfaces of the same public id
// into one row, and the alias listing advertises the merged endpoints across
// an alias's available targets. The request-time pool narrows to whatever
// subset actually serves the inbound endpoint, so every surfaced endpoint
// remains reachable.
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
