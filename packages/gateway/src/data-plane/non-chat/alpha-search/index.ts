import { encode } from './encode.ts';
import { failover } from './failover.ts';
import { parse } from './parse.ts';
import { measurePerformance } from './performance.ts';
import { provider, targets } from './provider.ts';
import { route } from './route.ts';
import { stripHeaders } from './strip-headers.ts';
import { computeUsage } from './usage.ts';
import { compose } from '../../pipeline/facts.ts';
import { httpEntry, httpExit } from '../shared/routing.ts';
import { asEntry } from '@floway-dev/pipeline';

const stages = [route, failover, measurePerformance, computeUsage, stripHeaders] as const;

export const alphaSearchIngress = asEntry(compose('alphaSearch.ingress', {
  entry: httpEntry,
  exit: httpExit,
  stages: [parse, encode, ...stages],
  ending: provider,
  targets,
}));

export const alphaSearchOperation = asEntry(compose('alphaSearch.operation', {
  entry: [...httpEntry, 'alphaSearch'],
  exit: [...httpExit, 'alphaSearch'],
  stages,
  ending: provider,
  targets,
}));
