import { openaiAudioSpeechPipeline, openaiAudioTranscriptionsPipeline } from './pipeline.ts';
import { serveHttp } from '../pipeline/http.ts';

export const openaiAudioTranscriptions = serveHttp(openaiAudioTranscriptionsPipeline);
export const openaiAudioSpeech = serveHttp(openaiAudioSpeechPipeline);
