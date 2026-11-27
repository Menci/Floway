import { discoverOpenAIAudioSpeech } from './discover-speech.ts';
import { discoverOpenAIAudioTranscriptions } from './discover-transcriptions.ts';
import { encodeOpenAIAudioSpeech } from './encode-speech.ts';
import { encodeOpenAIAudioTranscriptions } from './encode-transcriptions.ts';
import { failoverOpenAIAudioSpeech } from './failover-speech.ts';
import { failoverOpenAIAudioTranscriptions } from './failover-transcriptions.ts';
import { parseOpenAIAudioSpeech } from './parse-speech.ts';
import { parseOpenAIAudioTranscriptions } from './parse-transcriptions.ts';
import { measureOpenAIAudioSpeechPerformance } from './performance-speech.ts';
import { measureOpenAIAudioTranscriptionsPerformance } from './performance-transcriptions.ts';
import { openaiAudioSpeechProvider, openaiAudioSpeechTargets } from './provider-speech.ts';
import { openaiAudioTranscriptionsProvider, openaiAudioTranscriptionsTargets } from './provider-transcriptions.ts';
import { computeOpenAIAudioSpeechUsage } from './usage-speech.ts';
import { computeOpenAIAudioTranscriptionsUsage } from './usage-transcriptions.ts';
import { stripAuthenticationHeaders } from '../../pipeline/auth-headers.ts';
import { compose } from '../../pipeline/facts.ts';
import { storeUsage } from '../../pipeline/store-usage.ts';
import { httpEntry, httpExit } from '../shared/routing.ts';
import { asEntry } from '@floway-dev/pipeline';

export const openaiAudioSpeechIngress = asEntry(compose('openaiAudioSpeech.ingress', {
  entry: httpEntry,
  exit: httpExit,
  stages: [
    parseOpenAIAudioSpeech,
    encodeOpenAIAudioSpeech,
    discoverOpenAIAudioSpeech,
    failoverOpenAIAudioSpeech,
    stripAuthenticationHeaders,
    measureOpenAIAudioSpeechPerformance,
    storeUsage,
    computeOpenAIAudioSpeechUsage,
  ],
  ending: openaiAudioSpeechProvider,
  targets: openaiAudioSpeechTargets,
}));

export const openaiAudioTranscriptionsIngress = asEntry(compose('openaiAudioTranscriptions.ingress', {
  entry: httpEntry,
  exit: httpExit,
  stages: [
    parseOpenAIAudioTranscriptions,
    encodeOpenAIAudioTranscriptions,
    discoverOpenAIAudioTranscriptions,
    failoverOpenAIAudioTranscriptions,
    stripAuthenticationHeaders,
    measureOpenAIAudioTranscriptionsPerformance,
    storeUsage,
    computeOpenAIAudioTranscriptionsUsage,
  ],
  ending: openaiAudioTranscriptionsProvider,
  targets: openaiAudioTranscriptionsTargets,
}));
