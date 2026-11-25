import { CHATGPT_BACKEND_BASE, CHATGPT_CLI_VERSION, CHATGPT_ORIGINATOR, CHATGPT_RESPONSES_LITE_HEADER, CHATGPT_USER_AGENT } from '../constants.ts';
import { uuidV7 } from '../ids.ts';
import type { ChatGPTRequestIdentity } from '../responses-request.ts';
import { deleteHeader, getHeader, setHeader, type HttpHeaders, type HttpRequestFact } from '@floway-dev/http';
import { move } from '@floway-dev/pipeline';

export const trimHeader = (headers: HttpHeaders, name: string): string | null => {
  const value = getHeader(headers, name);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
};

const requestWithIdentity = (
  request: HttpRequestFact, path: string, body: object, accept: string, originator: string, fields: HttpHeaders,
): HttpRequestFact => {
  let headers = request.headers;
  for (const [name, value] of [
    ['originator', originator],
    ['user-agent', CHATGPT_USER_AGENT],
    ['version', CHATGPT_CLI_VERSION],
    ['accept', accept],
    ['content-type', 'application/json'],
  ] as const) {
    headers = setHeader(headers, name, value);
  }
  for (const [name, value] of fields) headers = setHeader(headers, name, value);
  return move({ ...request, method: 'POST', url: `${CHATGPT_BACKEND_BASE}${path}`, body, headers });
};

export const codexRequest = (
  request: HttpRequestFact,
  path: string,
  body: object,
  accept: string,
  identity: Pick<ChatGPTRequestIdentity, 'sessionId' | 'threadId' | 'clientRequestId' | 'windowId'>,
  turnMetadata: string | null,
  responsesLite: boolean,
): HttpRequestFact => {
  const headers: HttpHeaders = [
    ['session-id', identity.sessionId],
    ['thread-id', identity.threadId],
    ['x-client-request-id', identity.clientRequestId],
    ['x-codex-window-id', identity.windowId],
  ];
  if (turnMetadata !== null) headers.push(['x-codex-turn-metadata', turnMetadata]);
  if (responsesLite) headers.push([CHATGPT_RESPONSES_LITE_HEADER, 'true']);
  const cleaned = deleteHeader(deleteHeader(request.headers, 'session_id'), 'x-codex-turn-metadata');
  return requestWithIdentity({ ...request, headers: cleaned }, path, body, accept, CHATGPT_ORIGINATOR, headers);
};

export const codexImageRequest = (request: HttpRequestFact, path: string, body: object): HttpRequestFact =>
  requestWithIdentity(request, path, body, 'application/json', trimHeader(request.headers, 'originator') ?? CHATGPT_ORIGINATOR, [
    ['x-codex-image-turn-id', trimHeader(request.headers, 'x-codex-image-turn-id') ?? uuidV7()],
  ]);
