import type { TranslationUpstreamCapture } from './execute-translation.ts';
import { mergeForwardedUpstreamHeaders } from '../../shared/upstream-response.ts';
import { isJsonObject, type JsonObject } from '@floway-dev/protocols/common';
import type { TranslateTrip } from '@floway-dev/translate';
import {
  decodeResponseBody,
  internalErrorResult,
  plainResult,
  toInternalDebugError,
  type ApiErrorResult,
  type HttpHead,
  type InternalErrorResult,
  type PerformanceTelemetryContext,
  type PlainResult,
} from '@floway-dev/upstream';

export interface ReshapeTranslatedCountTokensOptions {
  readonly translateError: TranslateTrip<unknown, unknown, unknown>['error'];
  readonly fallbackErrorBody?: (status: number, message: string) => unknown;
  readonly extractCount: (decoded: JsonObject) => unknown;
  readonly encodeCount: (count: number) => unknown;
  readonly performance?: PerformanceTelemetryContext | undefined;
  readonly capture?: TranslationUpstreamCapture | undefined;
}

export const reshapeTranslatedCountTokens = (
  upstreamResult: ApiErrorResult | InternalErrorResult | PlainResult,
  options: ReshapeTranslatedCountTokensOptions,
): ApiErrorResult | InternalErrorResult | PlainResult => {
  if (upstreamResult.type === 'internal-error') return upstreamResult;

  const { status, headers } = upstreamResult.http;
  if (upstreamResult.type === 'plain' && upstreamResult.body === null && (status === 204 || status === 205 || status === 304)) {
    return upstreamResult;
  }
  const text = decodeResponseBody(upstreamResult.body);
  const http = { status, headers: mergeForwardedUpstreamHeaders({ 'content-type': 'application/json' }, headers) };
  if (upstreamResult.type === 'api-error' || status !== 200) {
    if (upstreamResult.type !== 'api-error' || upstreamResult.source === 'upstream') {
      options.capture?.upstreamApiError({ status, headers, body: upstreamResult.body });
    }
    const translated = options.translateError(status, headers, upstreamResult.body ?? new Uint8Array());
    let resultHttp: HttpHead;
    let payload: unknown;
    if (translated !== undefined) {
      resultHttp = {
        status: translated.status,
        headers: mergeForwardedUpstreamHeaders({ 'content-type': 'application/json' }, translated.headers),
      };
      payload = translated.body;
    } else if (options.fallbackErrorBody !== undefined) {
      resultHttp = http;
      payload = options.fallbackErrorBody(status, text.trim() || 'Upstream token counting request failed.');
    } else {
      return upstreamResult;
    }
    const body = new TextEncoder().encode(JSON.stringify(payload));
    return upstreamResult.type === 'api-error'
      ? { ...upstreamResult, http: resultHttp, body }
      : plainResult(resultHttp, body, upstreamResult.upstreamId);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (cause) {
    return internalErrorResult(502, toInternalDebugError(new Error('Invalid upstream token counting response.', { cause })), options.performance);
  }
  const count = isJsonObject(decoded) ? options.extractCount(decoded) : undefined;
  if (typeof count !== 'number') {
    return internalErrorResult(502, toInternalDebugError(new Error('Invalid upstream token counting response.')), options.performance);
  }
  return plainResult(
    http,
    new TextEncoder().encode(JSON.stringify(options.encodeCount(count))),
    upstreamResult.upstreamId,
  );
};
