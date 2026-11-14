import { classifyChatGPTHttpResponse, classifyChatGPTUnauthorizedResponse, decodeChatGPTUpstreamError } from '../fetch.ts';
import { chatgptCall, type ChatGPTHttpFacts, type ChatGPTOperation, type ChatGPTPipelineConfig } from '../pipeline-facts.ts';
import { exchangeResponse, takeHttpResponse, type HttpResponseFacts } from '@floway-dev/http/pipeline';
import { defer, defineStage, move, setRelease, type Deferred } from '@floway-dev/pipeline';
import type { ProviderServices } from '@floway-dev/provider';

type Observed = HttpResponseFacts & { 'response.chatgpt.background': Deferred<unknown>; 'response.chatgpt.failureBody': unknown };

export const observeChatGPTResponse = (config: ChatGPTPipelineConfig, operation: ChatGPTOperation) => defineStage<ChatGPTHttpFacts, ChatGPTHttpFacts, HttpResponseFacts, Observed, ProviderServices>({
  name: 'observeChatGPTResponse',
  through: {
    request: { needs: ['request.chatgpt.account', 'request.chatgpt.model', 'request.http.callId'], consumes: [], provides: [] },
    response: { needs: ['response.http.exchange', 'response.http.body'], consumes: ['response.http.exchange', 'response.http.body'], provides: ['response.http.exchange', 'response.http.body', 'response.chatgpt.background', 'response.chatgpt.failureBody'] },
  },
  execute: async (facts, next, use) => {
    const back = await next(move({ ...facts }));
    const exchange = back['response.http.exchange'];
    const pending: Promise<unknown>[] = [];
    if (exchange.type === 'transportFailure') return move({ ...back, 'response.chatgpt.background': defer(Promise.all(pending)), 'response.chatgpt.failureBody': null });
    const call = chatgptCall(config, facts, use, facts['request.chatgpt.model']);
    const response = exchangeResponse(exchange);
    let classified: Response;
    let failureBody: unknown = null;
    if (exchange.status === 401) {
      const parsed = decodeChatGPTUpstreamError(await response.text());
      if (exchange.body !== null) setRelease(exchange.body, async () => {});
      failureBody = parsed.body;
      classified = await classifyChatGPTUnauthorizedResponse(call, response, parsed);
    } else {
      classified = await classifyChatGPTHttpResponse({ ...call, call: { ...call.call, waitUntil: work => { pending.push(work); } } }, response, operation === 'alphaSearch' ? 'always' : 'when-present');
    }
    const retained = classified === response ? exchange : takeHttpResponse(classified);
    return move({ ...back, 'response.http.exchange': retained, 'response.http.body': retained.body, 'response.chatgpt.background': defer(Promise.all(pending)), 'response.chatgpt.failureBody': failureBody });
  },
});
