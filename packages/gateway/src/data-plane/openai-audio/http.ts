import type { AuthedContext } from '../../middleware/auth.ts';
import { servePipeline } from '../pipeline/host.ts';
import { createGatewayServices } from '../pipeline/services.ts';
import { openAIAudioTranscriptionsPipeline } from './pipeline/index.ts';

export const openaiAudioTranscriptions = (c: AuthedContext): Promise<Response> =>
  servePipeline(c, openAIAudioTranscriptionsPipeline, createGatewayServices);
