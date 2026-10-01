import { providerCalls } from '../../pipeline/provider-usage.ts';
import { dialFailure, readUpstreamBody, spentBody } from '../../pipeline/upstream-body.ts';
import type { ChatAnswer } from '../facts.ts';
import { exchangeResponse } from '@floway-dev/http/pipeline';
import type { Facts } from '@floway-dev/pipeline';
import type { ChatProviderOperation, ModelCandidate, ProviderChatResponse } from '@floway-dev/provider';

export const providerChatAnswer = async <O extends ChatProviderOperation>(candidate: ModelCandidate, back: ProviderChatResponse<O>) => {
  const { 'response.http.exchange': exchange, 'response.provider.output': output } = back;
  const billable = providerCalls(candidate, back as unknown as Facts);
  if (exchange.type === 'transportFailure') return {
    answer: dialFailure(exchange.error), status: 502, headers: [], billable, body: null,
  };
  if (output !== null) return {
    answer: output as ChatAnswer,
    status: 'kind' in output ? exchange.status : output.status,
    headers: exchange.headers,
    billable,
    body: 'kind' in output && output.kind === 'stream' ? exchange.body : spentBody(exchange.body),
  };
  const response = exchangeResponse(exchange);
  spentBody(exchange.body);
  const body = await readUpstreamBody(response);
  return {
    answer: { status: exchange.status, message: body.text, ...('json' in body ? { body: body.json } : {}) },
    status: exchange.status, headers: exchange.headers, billable, body: exchange.body,
  };
};
