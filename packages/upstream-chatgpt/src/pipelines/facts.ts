import type { ChatGPTResponsesLiteRequest } from '../responses-lite.ts';
import type { ChatGPTServices } from '../service.ts';
import { factSpace } from '@floway-dev/pipeline';
import type { ProtocolStream, UpstreamEvent, UpstreamHttpResponseFacts, UpstreamRequestFacts, UpstreamResponseFacts } from '@floway-dev/upstream';

type Request = UpstreamRequestFacts & {
  'chatgpt.responsesLite.movedFields': ChatGPTResponsesLiteRequest['movedFields'];
};

type Response = UpstreamResponseFacts & UpstreamHttpResponseFacts & {
  'chatgpt.openaiResponses.stream': ProtocolStream<UpstreamEvent<'openaiResponses'>>;
};

export const { defineStage, compose } = factSpace<Request, Response, ChatGPTServices>();
