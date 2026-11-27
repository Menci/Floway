import { discoverOpenAIEmbeddings } from './discover.ts';
import { encodeOpenAIEmbeddings } from './encode.ts';
import { failoverOpenAIEmbeddings } from './failover.ts';
import { parseOpenAIEmbeddings } from './parse.ts';
import { measureOpenAIEmbeddingsPerformance } from './performance.ts';
import { openaiEmbeddingsProvider, openaiEmbeddingsTargets } from './provider.ts';
import { computeOpenAIEmbeddingsUsage } from './usage.ts';
import { stripAuthenticationHeaders } from '../../pipeline/auth-headers.ts';
import { compose } from '../../pipeline/facts.ts';
import { storeUsage } from '../../pipeline/store-usage.ts';
import { httpEntry, httpExit } from '../shared/routing.ts';
import { asEntry } from '@floway-dev/pipeline';

export const openaiEmbeddingsIngress = asEntry(compose('openaiEmbeddings.ingress', {
  entry: httpEntry,
  exit: httpExit,
  stages: [
    parseOpenAIEmbeddings,
    encodeOpenAIEmbeddings,
    discoverOpenAIEmbeddings,
    failoverOpenAIEmbeddings,
    stripAuthenticationHeaders,
    measureOpenAIEmbeddingsPerformance,
    storeUsage,
    computeOpenAIEmbeddingsUsage,
  ],
  ending: openaiEmbeddingsProvider,
  targets: openaiEmbeddingsTargets,
}));
