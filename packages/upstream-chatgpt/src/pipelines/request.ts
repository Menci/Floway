import { CHATGPT_BACKEND_BASE, CHATGPT_CLI_VERSION, CHATGPT_ORIGINATOR, CHATGPT_RESPONSES_LITE_HEADER, CHATGPT_USER_AGENT } from '../constants.ts';
import { uuidV7 } from '../ids.ts';
import { trimHeader, type ChatGPTRequestIdentity } from '../wire.ts';
import type { HttpHeaders, HttpRequestFact } from '@floway-dev/http';

export const incomingHeaders = (entries: HttpHeaders): Headers => {
  const headers = new Headers();
  for (const [name, value] of entries) {
    if (typeof value !== 'string') throw new TypeError(`Expected a client-supplied ChatGPT header value for ${name}`);
    headers.append(name, value);
  }
  return headers;
};

const jsonRequest = (
  path: string, body: object, headers: HttpHeaders, accept: string, originator = CHATGPT_ORIGINATOR,
): HttpRequestFact => ({
  url: `${CHATGPT_BACKEND_BASE}${path}`,
  method: 'POST',
  headers: [
    ['originator', originator],
    ['user-agent', CHATGPT_USER_AGENT],
    ['version', CHATGPT_CLI_VERSION],
    ['accept', accept],
    ['content-type', 'application/json'],
    ...headers,
  ],
  body: JSON.stringify(body),
});

export const codexRequest = (
  path: string, accept: string, body: object, identity: ChatGPTRequestIdentity, turnMetadata: string | null, responsesLite: boolean,
): HttpRequestFact => {
  const headers: HttpHeaders = [
    ['session-id', identity.sessionId],
    ['thread-id', identity.threadId],
    ['x-client-request-id', identity.clientRequestId],
    ['x-codex-window-id', identity.windowId],
  ];
  if (turnMetadata !== null) headers.push(['x-codex-turn-metadata', turnMetadata]);
  if (responsesLite) headers.push([CHATGPT_RESPONSES_LITE_HEADER, 'true']);
  return jsonRequest(path, body, headers, accept);
};

export const imageRequest = (path: string, body: object, incoming: Headers): HttpRequestFact => jsonRequest(
  path, body, [['x-codex-image-turn-id', trimHeader(incoming, 'x-codex-image-turn-id') ?? uuidV7()]],
  'application/json', trimHeader(incoming, 'originator') ?? CHATGPT_ORIGINATOR,
);
