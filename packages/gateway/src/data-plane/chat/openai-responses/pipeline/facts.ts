import type { GatewayPipelineFacts } from '../../../pipeline/facts.ts';
import { chatBodyEntry, chatBodyExit } from '../../pipeline/topology.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

type OpenAIResponsesFacts = GatewayPipelineFacts & {
  readonly 'request.openaiResponses': CanonicalOpenAIResponsesPayload;
};

export type OpenAIResponsesAction = OpenAIResponsesFacts['request.openaiResponsesAction'];

export const openAIResponsesFactSpace = <Services>() => factSpace<OpenAIResponsesFacts, Services>();

export const openAIResponsesBodyEntry = [
  ...chatBodyEntry('openaiResponses'),
  'request.openaiResponsesAction',
  'request.ws.responseId?',
] as const;

export const openAIResponsesExit = chatBodyExit('openaiResponses');

export type OpenAIResponsesBodyInput =
  Pick<OpenAIResponsesFacts, Exclude<typeof openAIResponsesBodyEntry[number], 'request.ws.responseId?'>>
  & Partial<Pick<OpenAIResponsesFacts, 'request.ws.responseId'>>;

export type OpenAIResponsesAnswer = Pick<OpenAIResponsesFacts, typeof openAIResponsesExit[number]>;
