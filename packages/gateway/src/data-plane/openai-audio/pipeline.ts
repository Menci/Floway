import { encodeOpenAIAudioSpeech, encodeOpenAIAudioTranscriptions } from './encode.ts';
import { parseOpenAIAudioSpeech } from './parse-speech.ts';
import { openaiAudioError, parseOpenAIAudioTranscriptions } from './parse-transcriptions.ts';
import { computeOpenAIAudioSpeechUsage, computeOpenAIAudioTranscriptionsUsage } from './usage.ts';
import { stripAuthenticationHeaders } from '../pipeline/auth-headers.ts';
import { discoverCandidates } from '../pipeline/discover-candidates.ts';
import { localResponseHead } from '../pipeline/encode.ts';
import { compose } from '../pipeline/facts.ts';
import { failover } from '../pipeline/failover.ts';
import { measurePerformance } from '../pipeline/performance.ts';
import { providerTargets } from '../pipeline/provider-targets.ts';
import { storeUsage } from '../pipeline/store-usage.ts';
import { appendFailedUpstreams } from '../shared/failed-upstreams.ts';

const entry = [
  'request.http',
  'request.auth.apiKeyId',
  'request.auth.userId',
  'request.auth.isAdmin',
  'request.auth.upstreamIds',
  'request.auth.randomizeUpstreams',
  'serve.runtimeLocation',
] as const;
const exit = ['response.http', 'response.candidate?', 'response.usage?', 'response.performance?', 'response.outcome', 'response.requestedModel?'] as const;

const modelUnavailable = (endpoint: string) => ({
  model,
  exists,
  failedUpstreams,
}: {
  model: string;
  exists: boolean;
  failedUpstreams: readonly string[];
}) => {
  const message = exists
    ? `Model ${model} does not support the ${endpoint} endpoint.`
    : `Model ${model} is not available on any configured upstream.`;
  return {
    http: { ...localResponseHead(exists ? 400 : 404), body: null },
    outcome: { kind: 'error' as const, source: 'local' as const, error: openaiAudioError(appendFailedUpstreams(message, failedUpstreams)) },
  };
};

const transcriptions = 'openaiAudioTranscriptions';
export const openaiAudioTranscriptionsPipeline = compose(transcriptions, {
  entry,
  exit,
  stages: [
    stripAuthenticationHeaders,
    parseOpenAIAudioTranscriptions,
    encodeOpenAIAudioTranscriptions,
    discoverCandidates(transcriptions, {
      kind: 'transcription',
      model(payload) {
        const model = payload.entries.find(entry => entry.name === 'model')?.value;
        if (typeof model !== 'string') throw new Error('Expected the parsed transcription model field');
        return model;
      },
      supports: model => model.endpoints.openaiAudioTranscriptions !== undefined,
      unavailable: modelUnavailable('/audio/transcriptions'),
    }),
    failover(transcriptions),
    measurePerformance(transcriptions, 'audio_transcription'),
    storeUsage,
    computeOpenAIAudioTranscriptionsUsage,
  ],
  ...providerTargets(transcriptions),
});

const speech = 'openaiAudioSpeech';
export const openaiAudioSpeechPipeline = compose(speech, {
  entry,
  exit,
  stages: [
    stripAuthenticationHeaders,
    parseOpenAIAudioSpeech,
    encodeOpenAIAudioSpeech,
    discoverCandidates(speech, {
      kind: 'speech',
      model: payload => payload.model,
      supports: model => model.endpoints.openaiAudioSpeech !== undefined,
      unavailable: modelUnavailable('/audio/speech'),
    }),
    failover(speech),
    measurePerformance(speech, 'audio_speech'),
    storeUsage,
    computeOpenAIAudioSpeechUsage,
  ],
  ...providerTargets(speech),
});
