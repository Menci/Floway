import type { HttpResponseExchange } from './pipeline-types.ts';
import { own } from '@floway-dev/pipeline';

export const takeHttpResponse = (response: Response): HttpResponseExchange => {
  const rawBody = response.body;
  const body = rawBody === null ? null : own(rawBody, async () => { await rawBody.cancel(); });
  return {
    type: 'response' as const,
    status: response.status,
    statusText: response.statusText,
    headers: [...response.headers],
    body,
  };
};

export const exchangeResponse = (exchange: HttpResponseExchange): Response =>
  new Response(exchange.body, {
    status: exchange.status,
    statusText: exchange.statusText,
    headers: exchange.headers.map(([name, value]): [string, string] => [name, value]),
  });
