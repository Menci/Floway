import type { BillableEntity } from './facts.ts';
import { telemetryModelIdentity } from '../shared/telemetry/attribution.ts';
import type { Facts } from '@floway-dev/pipeline';
import type { ModelCandidate, ProviderResponse } from '@floway-dev/provider';

export const providerUsage = (
  candidate: ModelCandidate,
  response: Pick<ProviderResponse, 'response.provider.previousCalls'>,
  finalCall: readonly BillableEntity[],
): readonly BillableEntity[] => {
  const previous = response['response.provider.previousCalls'];
  if (previous.length === 0) return finalCall;
  return [
    ...previous.map(call => ({ identity: telemetryModelIdentity(candidate, call.modelKey), quantities: {} })),
    ...finalCall,
  ];
};

export const providerCalls = (candidate: ModelCandidate, facts: Facts): readonly BillableEntity[] => {
  if (!('response.provider.called' in facts)) return [];
  const response = facts as unknown as ProviderResponse;
  const current: readonly BillableEntity[] = response['response.provider.called']
    ? [{ identity: telemetryModelIdentity(candidate, response['response.provider.modelKey']), quantities: {} }] : [];
  return providerUsage(candidate, response, current);
};
