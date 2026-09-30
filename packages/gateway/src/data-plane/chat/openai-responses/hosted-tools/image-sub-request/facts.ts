import type { ImageGenerationRequest } from './request.ts';
import type { OpenAIImagesFacts } from '../../../../openai-images/facts.ts';
import type { HostedToolLifecycleEvent, HostedToolTerminal } from '../types.ts';

export interface ImageSubRequestFacts extends OpenAIImagesFacts {
  'request.imageGeneration.canonical': ImageGenerationRequest;
  'response.imageGeneration.lifecycle': AsyncGenerator<HostedToolLifecycleEvent, HostedToolTerminal>;
}

export type Fields<K extends keyof ImageSubRequestFacts> = { [P in K]: ImageSubRequestFacts[P] };
export type ImageSubRequestEntry = Fields<'request.imageGeneration.canonical' | 'ingress.http.headers'>;
export type ImageSubRequestExit = Fields<'response.imageGeneration.lifecycle' | 'response.openaiImages.streamedUsage' | 'response.http.status'>;
