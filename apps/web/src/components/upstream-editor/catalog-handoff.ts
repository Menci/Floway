import type { ModelCatalogFetch } from './data';

interface CatalogHandoff {
  upstreamId: string;
  configVersion: number;
  catalog: ModelCatalogFetch;
}

const handoffs = new Map<string, CatalogHandoff>();
export const CATALOG_HANDOFF_QUERY = 'modelCatalogHandoff';

export const stageCatalogHandoff = (handoff: CatalogHandoff): string => {
  const token = crypto.randomUUID();
  handoffs.set(token, handoff);
  return token;
};

export const consumeCatalogHandoff = (token: string, upstreamId: string, configVersion: number): ModelCatalogFetch | null => {
  const handoff = handoffs.get(token);
  handoffs.delete(token);
  return handoff?.upstreamId === upstreamId && handoff.configVersion === configVersion ? handoff.catalog : null;
};
