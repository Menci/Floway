import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import type { ChatTargetApi, RouteCandidate } from '@floway-dev/provider';

export interface OpenAIResponsesStageFacts {
  readonly 'route.candidate': RouteCandidate;
  readonly 'request.payload': CanonicalOpenAIResponsesPayload;
  readonly 'request.action': 'generate' | 'compact';
  readonly 'route.targetApi': ChatTargetApi;
}

export type OpenAIResponsesStageOutcome = import('../../pipeline/index.ts').ChatAttemptOutcome<OpenAIResponsesStreamEventEx>;
