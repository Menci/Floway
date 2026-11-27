import { discoverOpenAIImagesEdits } from './discover-edits.ts';
import { discoverOpenAIImagesGenerations } from './discover-generations.ts';
import { encodeOpenAIImagesEdits } from './encode-edits.ts';
import { encodeOpenAIImagesGenerations } from './encode-generations.ts';
import { failoverOpenAIImagesEdits } from './failover-edits.ts';
import { failoverOpenAIImagesGenerations } from './failover-generations.ts';
import { parseOpenAIImagesEdits } from './parse-edits.ts';
import { parseOpenAIImagesGenerations } from './parse-generations.ts';
import { measureOpenAIImagesEditsPerformance } from './performance-edits.ts';
import { measureOpenAIImagesGenerationsPerformance } from './performance-generations.ts';
import { openaiImagesEditsProvider, openaiImagesEditsTargets } from './provider-edits.ts';
import { openaiImagesGenerationsProvider, openaiImagesGenerationsTargets } from './provider-generations.ts';
import { computeOpenAIImagesEditsUsage } from './usage-edits.ts';
import { computeOpenAIImagesGenerationsUsage } from './usage-generations.ts';
import { stripAuthenticationHeaders } from '../../pipeline/auth-headers.ts';
import { compose } from '../../pipeline/facts.ts';
import { storeUsage } from '../../pipeline/store-usage.ts';
import { httpEntry, httpExit } from '../shared/routing.ts';
import { asEntry } from '@floway-dev/pipeline';

const openaiImagesGenerationsStages = [
  discoverOpenAIImagesGenerations,
  failoverOpenAIImagesGenerations,
  stripAuthenticationHeaders,
  measureOpenAIImagesGenerationsPerformance,
  storeUsage,
  computeOpenAIImagesGenerationsUsage,
] as const;

export const openaiImagesGenerationsIngress = asEntry(compose('openaiImagesGenerations.ingress', {
  entry: httpEntry,
  exit: httpExit,
  stages: [parseOpenAIImagesGenerations, encodeOpenAIImagesGenerations, ...openaiImagesGenerationsStages],
  ending: openaiImagesGenerationsProvider,
  targets: openaiImagesGenerationsTargets,
}));

export const openaiImagesGenerationsOperation = asEntry(compose('openaiImagesGenerations.operation', {
  entry: [...httpEntry, 'openaiImagesGenerations'],
  exit: [...httpExit, 'openaiImagesGenerations'],
  stages: openaiImagesGenerationsStages,
  ending: openaiImagesGenerationsProvider,
  targets: openaiImagesGenerationsTargets,
}));

const openaiImagesEditsStages = [
  discoverOpenAIImagesEdits,
  failoverOpenAIImagesEdits,
  stripAuthenticationHeaders,
  measureOpenAIImagesEditsPerformance,
  storeUsage,
  computeOpenAIImagesEditsUsage,
] as const;

export const openaiImagesEditsIngress = asEntry(compose('openaiImagesEdits.ingress', {
  entry: httpEntry,
  exit: httpExit,
  stages: [parseOpenAIImagesEdits, encodeOpenAIImagesEdits, ...openaiImagesEditsStages],
  ending: openaiImagesEditsProvider,
  targets: openaiImagesEditsTargets,
}));

export const openaiImagesEditsOperation = asEntry(compose('openaiImagesEdits.operation', {
  entry: [...httpEntry, 'openaiImagesEdits', 'requestedModel'],
  exit: [...httpExit, 'openaiImagesEdits'],
  stages: openaiImagesEditsStages,
  ending: openaiImagesEditsProvider,
  targets: openaiImagesEditsTargets,
}));
