import { encodeAlphaSearch } from './encode.ts';
import { parseAlphaSearch } from './parse.ts';
import { routeAlphaSearch } from './route-search.ts';
import { computeUsage } from '../pipeline/compute-usage.ts';
import { compose } from '../pipeline/facts.ts';
import { failover } from '../pipeline/failover.ts';
import { measurePerformance } from '../pipeline/performance.ts';
import { providerTargets } from '../pipeline/provider-targets.ts';
import { stripHeaders } from '@floway-dev/provider';

const operation = 'alphaSearch';
// https://github.com/openai/codex/blob/2e1607ee2fa8099a233df7437adee5f16a741905/codex-rs/codex-api/src/endpoint/search.rs#L31-L47
const stripAlphaSearchHeaders = stripHeaders('alphaSearch.strip-headers', name => name === 'x-codex-turn-metadata');

const entry = [
  'request.http',
  'request.auth.apiKeyId',
  'request.auth.userId',
  'request.auth.isAdmin',
  'request.auth.upstreamIds',
  'serve.runtimeLocation',
] as const;
const stages = [
  routeAlphaSearch,
  failover(operation),
  measurePerformance(operation, 'alpha_search'),
  computeUsage(operation, { result: () => [] }),
] as const;

export const alphaSearchPipeline = compose(operation, {
  entry,
  exit: ['response.http', 'response.candidate?', 'response.usage?', 'response.performance?', 'response.outcome'],
  stages: [parseAlphaSearch, stripAlphaSearchHeaders, encodeAlphaSearch, ...stages],
  ...providerTargets(operation),
});

export const alphaSearchOperation = compose(`${operation}.operation`, {
  entry: [...entry, 'request.alphaSearch'],
  exit: ['response.http', 'response.alphaSearch', 'response.candidate?', 'response.usage?', 'response.performance?'],
  stages: [stripAlphaSearchHeaders, ...stages],
  ...providerTargets(operation),
});
