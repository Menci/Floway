import type { Candidate } from './facts.ts';
import type { GatewayServices, CatalogCandidateRequest } from './services.ts';

interface DiscoveryOptions<Payload> extends CatalogCandidateRequest {
  payload: Payload;
  supports(candidate: Candidate, payload: Payload): boolean;
  incompatibility?(candidate: Candidate, payload: Payload): string | null;
}

export const discoverCandidates = async <Payload>(
  services: Pick<GatewayServices, 'catalogCandidates'>,
  { payload, supports, incompatibility, ...request }: DiscoveryOptions<Payload>,
): Promise<{ candidates: readonly Candidate[]; exists: boolean; incompatibilities: readonly string[] }> => {
  const { candidates, sawModel } = await services.catalogCandidates(request);
  const viable: Candidate[] = [];
  const incompatibilities = new Set<string>();
  for (const candidate of candidates) {
    if (!supports(candidate, payload)) continue;
    const message = incompatibility?.(candidate, payload);
    if (message != null) {
      incompatibilities.add(message);
      continue;
    }
    viable.push(candidate);
  }
  return { candidates: viable, exists: sawModel, incompatibilities: [...incompatibilities] };
};
