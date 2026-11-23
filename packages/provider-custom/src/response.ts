import { Bytes, defineStage, type FactValue } from '@floway-dev/pipeline';
import { geminiGenerateContentStatusForHttpStatus } from '@floway-dev/protocols/gemini-generate-content';
import { readHttpBody, setHeader, type HttpResponseFacts } from '@floway-dev/provider';

export const geminiErrorBody = (status: number, text: string): FactValue => ({
  error: {
    code: status,
    message: text.trim() || `Upstream returned HTTP ${status}`,
    status: geminiGenerateContentStatusForHttpStatus(status) ?? 'UNKNOWN',
  },
});

type HttpOutput = { readonly 'response.http': HttpResponseFacts };

export const requireJsonResponseStage = (
  operation: string,
  formatError: (message: string) => FactValue = message => ({ error: { type: 'upstream_invalid_json', message } }),
) => defineStage<{}, {}, HttpOutput, HttpOutput>({
  name: 'requireJsonResponse',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: { needs: ['response.http'], consumes: [], provides: ['response.http'] },
  },
  async execute(facts, scope) {
    const back = await scope.next(facts);
    const http = back['response.http'];
    if (http.status < 200 || http.status >= 300) return back;

    // Keep the original JSON bytes for the caller's dialect-specific decoding.
    const body = await readHttpBody(http.body);
    if (!body.ok) return {
      ...back,
      'response.http': { ...http, status: 502, statusText: '', body: null, transportError: body.error },
    };

    try {
      JSON.parse(body.bytes.utf8());
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const body = formatError(`Upstream returned invalid ${operation} JSON.`);
      return {
        ...back,
        'response.http': {
          ...http,
          status: 502,
          statusText: '',
          headers: setHeader(http.headers, 'content-type', 'application/json'),
          body: Bytes.fromUtf8(JSON.stringify(body)),
        },
      };
    }
    return { ...back, 'response.http': { ...http, body: body.bytes } };
  },
});
