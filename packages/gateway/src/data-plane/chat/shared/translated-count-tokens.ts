import type { TranslationUpstreamCapture } from './execute-translation.ts';
import { mergeForwardedUpstreamHeaders } from '../../shared/upstream-response.ts';
import type { TranslateTrip } from '@floway-dev/translate';
import { decodeResponseBody, plainResult, type ApiErrorResult, type PlainResult } from '@floway-dev/upstream';

export interface ReshapeTranslatedCountTokensOptions {
  readonly translateError: TranslateTrip<unknown, unknown, unknown>['error'];
  readonly fallbackErrorBody: (status: number, text: string) => Uint8Array;
  readonly invalidResponseResult: (error: Error) => PlainResult;
  readonly extractCount: (decoded: unknown) => number | undefined;
  readonly encodeCount: (count: number) => unknown;
  readonly capture?: TranslationUpstreamCapture | undefined;
}

// Reshape a translated upstream `countTokens` response into the source protocol's
// count envelope while preserving status codes, forwarded headers, structured
// error translation, and pre-translation dump capture.
export const reshapeTranslatedCountTokens = (
  upstreamResult: ApiErrorResult | PlainResult,
  options: ReshapeTranslatedCountTokensOptions,
): ApiErrorResult | PlainResult => {
  const { status, headers } = upstreamResult.http;
  if (upstreamResult.type === 'plain' && upstreamResult.body === null && (status === 204 || status === 205 || status === 304)) {
    return upstreamResult;
  }
  const text = decodeResponseBody(upstreamResult.body);
  const http = { status, headers: mergeForwardedUpstreamHeaders({ 'content-type': 'application/json' }, headers) };
  if (upstreamResult.type === 'api-error' || status !== 200) {
    options.capture?.upstreamApiError({ status, headers, body: upstreamResult.body });
    const rawBody = upstreamResult.body ?? new Uint8Array();
    const translated = options.translateError(status, headers, rawBody);
    if (translated !== undefined) {
      const translatedHttp = {
        status: translated.status,
        headers: mergeForwardedUpstreamHeaders({ 'content-type': 'application/json' }, translated.headers),
      };
      const body = new TextEncoder().encode(JSON.stringify(translated.body));
      return upstreamResult.type === 'api-error'
        ? { ...upstreamResult, http: translatedHttp, body }
        : plainResult(translatedHttp, body, upstreamResult.upstreamId);
    }
    const body = options.fallbackErrorBody(status, text);
    return upstreamResult.type === 'api-error'
      ? { ...upstreamResult, http, body }
      : plainResult(http, body, upstreamResult.upstreamId);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (cause) {
    return options.invalidResponseResult(new Error('Invalid upstream token counting response.', { cause }));
  }
  const count = options.extractCount(decoded);
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    return options.invalidResponseResult(new Error('Invalid upstream token counting response.'));
  }
  return plainResult(
    http,
    new TextEncoder().encode(JSON.stringify(options.encodeCount(count))),
    upstreamResult.upstreamId,
  );
};
