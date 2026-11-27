import type { HttpResponseFact } from '@floway-dev/http';
import type { ProtocolError } from '@floway-dev/upstream';

export interface LocalChatAnswer {
  http: HttpResponseFact;
  outcome: ProtocolError;
}

export const localChatAnswer = (status: number, error: unknown): LocalChatAnswer => ({
  http: { status, statusText: '', headers: [['content-type', 'application/json']], body: null },
  outcome: { kind: 'error', source: 'local', error },
});

export const openAIChatError = (
  status: number,
  message: string,
  extra?: { readonly param: string; readonly code: string | null },
): LocalChatAnswer => localChatAnswer(status, { error: { message, type: 'invalid_request_error', ...extra } });
