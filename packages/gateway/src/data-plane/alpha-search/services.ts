import type { GatewayServices } from '../pipeline/services.ts';
import type { ConfiguredWebSearchProvider } from '../tools/web-search/types.ts';

/** The configured search backend is reached through a resolver rather than a fact: it holds
 *  live handles, and the operator's provider credential is what builds one — so nothing about
 *  it is dumpable and none of it belongs in the record. */
export interface SearchServices extends GatewayServices {
  readonly searchProvider: () => Promise<ConfiguredWebSearchProvider>;
}
