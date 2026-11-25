import { formatOpenAIError } from '../errors.ts';
import { getHeader } from '@floway-dev/http';
import { isEventStreamMediaType } from '@floway-dev/protocols/common';
import { decodeOpenAIAudioTranscriptionsStream } from '@floway-dev/protocols/openai-audio';
import { parseHttpResponse } from '@floway-dev/provider';

export const parseResponse = parseHttpResponse('openaiAudioTranscriptions', {
  select: (_body, http) => {
    const type = getHeader(http.headers, 'content-type');
    return typeof type === 'string' && isEventStreamMediaType(type) ? 'stream' : 'result';
  },
  stream: decodeOpenAIAudioTranscriptionsStream,
  result: body => ({ ok: true, value: body }),
  format: formatOpenAIError,
});
