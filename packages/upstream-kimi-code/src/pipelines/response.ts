import type { HttpResponseFact } from '@floway-dev/http';
import { protocolErrorDebugFields, type FormatProtocolError, type ProtocolError, type ProtocolStreamDecoder } from '@floway-dev/upstream';

export const MAX_KIMI_CODE_ERROR_BODY_BYTES = 1024 * 1024;
export const MAX_KIMI_CODE_COUNT_TOKENS_BODY_BYTES = 1024 * 1024;

const errorType = (status: number | null): string => status === null || status >= 500 ? 'api_error' : 'invalid_request_error';

export const formatOpenAIError: FormatProtocolError = (status, message, diagnostic) => ({
  error: { type: errorType(status), message, ...protocolErrorDebugFields(diagnostic) },
});
export const formatAnthropicError: FormatProtocolError = (status, message, diagnostic) => ({
  type: 'error',
  error: { type: errorType(status), message, ...protocolErrorDebugFields(diagnostic) },
});

export const invalidSpeed = (message: string, format: FormatProtocolError): { http: HttpResponseFact; outcome: ProtocolError } => ({
  http: { status: 400, statusText: '', headers: [['content-type', 'application/json']], body: null },
  outcome: { kind: 'error', source: 'local', error: format(400, message) },
});

export const mapProtocolEvents = <Event>(decode: ProtocolStreamDecoder<Event>, map: (event: Event) => Event): ProtocolStreamDecoder<Event> => async function* (source) {
  for await (const item of decode(source)) yield item.ok ? { ok: true, value: map(item.value) } : item;
};
