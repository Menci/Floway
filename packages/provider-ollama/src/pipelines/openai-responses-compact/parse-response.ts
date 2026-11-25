import { formatOpenAIError } from '../errors.ts';
import { decodeOpenAIResponsesCompactionResult } from '@floway-dev/protocols/openai-responses';
import { parseJsonBody, parseResultResponse } from '@floway-dev/provider';

export const parseResponse = parseResultResponse('openaiResponsesCompact', bytes => {
  const parsed = parseJsonBody(bytes);
  return parsed.ok ? decodeOpenAIResponsesCompactionResult(parsed.value) : parsed;
}, formatOpenAIError);
