import { CHATGPT_BACKEND_BASE, CHATGPT_CLI_VERSION, CHATGPT_ORIGINATOR, CHATGPT_USER_AGENT } from '../constants.ts';
import type { ChatGPTAuthorization } from '../service.ts';
import { getHeaders, type HttpHeaders, type HttpRequestFact } from '@floway-dev/http';

export const trimHeader = (headers: HttpHeaders, name: string): string | null => {
  const found = getHeaders(headers, name).filter((value): value is string => typeof value === 'string').join(', ').trim();
  return found.length === 0 ? null : found;
};

export const stringField = (record: Record<string, unknown> | null, key: string): string | null => {
  const value = record?.[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

export const chatgptRequest = (path: string, accept: string, headers: HttpHeaders, body: Uint8Array, contentType: string, originator = CHATGPT_ORIGINATOR): HttpRequestFact => ({
  url: `${CHATGPT_BACKEND_BASE}${path}`,
  method: 'POST',
  headers: [
    ['originator', originator],
    ['user-agent', CHATGPT_USER_AGENT],
    ['version', CHATGPT_CLI_VERSION],
    ['accept', accept],
    ['content-type', contentType],
    ...headers,
  ],
  body,
});

export const chatgptJsonRequest = (path: string, accept: string, headers: HttpHeaders, body: Record<string, unknown>, originator?: string): HttpRequestFact =>
  chatgptRequest(path, accept, headers, new TextEncoder().encode(JSON.stringify(body)), 'application/json', originator);

export const authorizeRequest = (request: HttpRequestFact, authorization: Extract<ChatGPTAuthorization, { kind: 'authorized' }>, accountId: string | null): HttpRequestFact => {
  const headers: HttpHeaders = [...request.headers, ['authorization', authorization.bearer]];
  if (accountId !== null) headers.push(['chatgpt-account-id', accountId]);
  return { ...request, headers };
};
