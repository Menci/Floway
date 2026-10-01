import type { ChatProviderOperation, ProviderChatResponse, ProviderChatServices, ProviderOperationOutputs, ProviderProtocolFailure } from '../pipeline.ts';
import { exchangeResponse, type HttpRequestFacts, type HttpResponseFacts, type HttpResponseExchange } from '@floway-dev/http/pipeline';
import { defineStage, move, setRelease } from '@floway-dev/pipeline';
import { parseAnthropicMessagesStream } from '@floway-dev/protocols/anthropic-messages';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import { parseOpenAIChatCompletionsStream } from '@floway-dev/protocols/openai-chat-completions';
import { parseOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';

type Request = Pick<HttpRequestFacts, 'request.http.callId'>;
type Up = HttpResponseFacts & { 'response.provider.responsesAction': 'generate' | 'compact' };
type Answer<O extends ChatProviderOperation> = HttpResponseFacts & Pick<ProviderChatResponse<O>, 'response.provider.output'>;

const parsedBody = (text: string): unknown => {
  try { return JSON.parse(text); } catch (error) { if (!(error instanceof SyntaxError)) throw error; return text; }
};

const protocolFailure = (exchange: HttpResponseExchange, text: string): ProviderProtocolFailure => {
  const type = exchange.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';
  const snippet = text.length === 0 ? '<empty>' : text.length > 1024 ? `${text.slice(0, 1024)}...[truncated]` : text;
  return {
    status: 502,
    message: `Upstream returned ${exchange.status} with content-type "${type || 'unknown'}" but stream is required (provider must force stream=true and return text/event-stream when response.ok). Body: ${snippet}`,
    body: parsedBody(text),
  };
};

export const decodeProviderResponse = <O extends ChatProviderOperation>(operation: O) => defineStage<Request, Request, Up, Answer<O>, ProviderChatServices>({
  name: `decodeProvider${operation.replace(/^openai/, 'OpenAI').replace(/^anthropic/, 'Anthropic')}`,
  through: {
    request: { needs: ['request.http.callId'], consumes: [], provides: [] },
    response: { needs: ['response.http.exchange', 'response.http.body', ...(operation === 'openaiResponses' || operation === 'openaiResponsesCompact' ? ['response.provider.responsesAction' as const] : [])], consumes: ['response.http.body'], provides: ['response.http.body', 'response.provider.output'] },
  },
  execute: async (facts, next, use) => {
    const back = await next(move({ ...facts }));
    const exchange = back['response.http.exchange'];
    const output = (answer: ProviderOperationOutputs[O] | ProviderProtocolFailure | null) => move({ ...back, 'response.provider.output': answer });
    if (exchange.type === 'transportFailure' || exchange.status < 200 || exchange.status >= 300) return output(null);
    if ((operation === 'openaiResponses' || operation === 'openaiResponsesCompact') && back['response.provider.responsesAction'] === 'compact' || operation === 'anthropicMessagesCountTokens') {
      const response = exchangeResponse(exchange);
      if (exchange.body !== null) setRelease(exchange.body, async () => {});
      const text = await response.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return output({ status: 502, message: `Upstream returned invalid ${operation} JSON`, body: text });
      }
      return output({ kind: 'value', body } as ProviderOperationOutputs[O]);
    }
    const contentType = exchange.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
    if (exchange.body === null || !isEventStreamMediaType(contentType)) {
      const response = exchangeResponse(exchange);
      if (exchange.body !== null) setRelease(exchange.body, async () => {});
      const text = await response.text();
      return output(protocolFailure(exchange, text));
    }
    const signal = use.httpCall(facts['request.http.callId']).signal;
    if (operation === 'anthropicMessages') return output({ kind: 'stream', frames: use.recordProtocolFrames(parseAnthropicMessagesStream(exchange.body, { signal })) } as ProviderOperationOutputs[O]);
    if (operation === 'openaiChatCompletions') return output({ kind: 'stream', frames: use.recordProtocolFrames(parseOpenAIChatCompletionsStream(exchange.body, { signal })) } as ProviderOperationOutputs[O]);
    return output({ kind: 'stream', frames: use.recordProtocolFrames(parseOpenAIResponsesStream(exchange.body, { signal })) } as ProviderOperationOutputs[O]);
  },
});
