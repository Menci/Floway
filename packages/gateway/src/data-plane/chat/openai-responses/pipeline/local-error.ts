import { localChatHead } from '../../pipeline/encode.ts';
import type { HttpResponseFact } from '@floway-dev/http';
import type { ProtocolError } from '@floway-dev/upstream';

export const openAIResponsesLocalError = (
  status: number,
  message: string,
  { param = 'input', code = null }: { param?: string | null; code?: string | null } = {},
): { http: HttpResponseFact; openaiResponses: ProtocolError } => ({
  http: localChatHead(status),
  openaiResponses: { kind: 'error', source: 'local', error: { error: { message, type: 'invalid_request_error', param, code } } },
});
