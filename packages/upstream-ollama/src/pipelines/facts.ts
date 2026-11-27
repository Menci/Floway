import type { OllamaPipelineServices } from '../service.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { UpstreamHttpResponseFacts, UpstreamRequestFacts, UpstreamResponseFacts } from '@floway-dev/upstream';

export const { defineStage, compose } = factSpace<UpstreamRequestFacts, UpstreamResponseFacts & UpstreamHttpResponseFacts, OllamaPipelineServices>();

export const MODEL_ENTRY = ['http', 'upstream', 'model'] as const;
export const HTTP_ANSWER = ['http', 'http.error?'] as const;
