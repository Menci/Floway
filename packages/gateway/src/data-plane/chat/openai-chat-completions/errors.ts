import { localResponseHead } from '../../pipeline/encode.ts';

export const openAIChatCompletionsLocalError = (status: number, message: string, fields?: { param: string; code: string | null }) => ({
  http: { ...localResponseHead(status), body: null },
  outcome: {
    kind: 'error' as const,
    source: 'local' as const,
    error: { error: { message, type: 'invalid_request_error', ...fields } },
  },
});
