import { geminiGenerateContentStatusForHttpStatus } from './error-status.ts';
import type { GeminiGenerateContentErrorResponse } from './index.ts';

// https://cloud.google.com/apis/design/errors#error_model
export const formatGeminiGenerateContentError = (
  status: number | null,
  message: string,
  details?: GeminiGenerateContentErrorResponse['error']['details'],
): GeminiGenerateContentErrorResponse => {
  const code = status ?? 500;
  return { error: { code, status: geminiGenerateContentStatusForHttpStatus(code) ?? 'UNKNOWN', message, ...(details === undefined ? {} : { details }) } };
};
