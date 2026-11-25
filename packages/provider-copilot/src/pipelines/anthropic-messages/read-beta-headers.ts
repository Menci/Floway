import { getHeaders, type HttpHeaders } from '@floway-dev/http';
import { parseAnthropicBetaHeader } from '@floway-dev/protocols/anthropic-messages';

export const readBetaHeaders = (headers: HttpHeaders): string[] =>
  getHeaders(headers, 'anthropic-beta').flatMap(value => parseAnthropicBetaHeader(typeof value === 'string' ? value : value.reveal()));
