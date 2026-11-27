import { discover } from './discover.ts';
import { encode } from './encode.ts';
import { compose } from './facts.ts';
import { failover } from './failover.ts';
import { parse } from './parse.ts';
import { measurePerformance } from './performance.ts';
import { provider, targets } from './provider.ts';
import { computeUsage } from './usage.ts';
import { stripAuthenticationHeaders } from '../../pipeline/auth-headers.ts';
import { storeUsage } from '../../pipeline/store-usage.ts';
import { httpEntry, httpExit } from '../shared/routing.ts';
import { asEntry } from '@floway-dev/pipeline';

export const rerankIngress = asEntry(compose('rerank.ingress', {
  entry: [...httpEntry, 'rerankDialect'],
  exit: httpExit,
  stages: [parse, encode, discover, failover, measurePerformance, storeUsage, computeUsage, stripAuthenticationHeaders],
  ending: provider,
  targets,
}));
