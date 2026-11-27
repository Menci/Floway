import { discoverOpenAICompletions } from './discover.ts';
import { encodeOpenAICompletions } from './encode.ts';
import { failoverOpenAICompletions } from './failover.ts';
import { includeOpenAICompletionsUsage } from './include-usage.ts';
import { parseOpenAICompletions } from './parse.ts';
import { measureOpenAICompletionsPerformance } from './performance.ts';
import { openaiCompletionsProvider, openaiCompletionsTargets } from './provider.ts';
import { computeOpenAICompletionsUsage } from './usage.ts';
import { stripAuthenticationHeaders } from '../../pipeline/auth-headers.ts';
import { compose } from '../../pipeline/facts.ts';
import { storeUsage } from '../../pipeline/store-usage.ts';
import { httpEntry, httpExit } from '../shared/routing.ts';
import { asEntry } from '@floway-dev/pipeline';

export const openaiCompletionsIngress = asEntry(compose('openaiCompletions.ingress', {
  entry: httpEntry,
  exit: httpExit,
  stages: [
    parseOpenAICompletions,
    encodeOpenAICompletions,
    discoverOpenAICompletions,
    failoverOpenAICompletions,
    stripAuthenticationHeaders,
    measureOpenAICompletionsPerformance,
    storeUsage,
    computeOpenAICompletionsUsage,
    includeOpenAICompletionsUsage,
  ],
  ending: openaiCompletionsProvider,
  targets: openaiCompletionsTargets,
}));
