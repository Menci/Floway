import type { HttpBody, HttpBodyEncoding } from './request-content.ts';
import type { Fetcher } from './types.ts';
import type { Owned, Secret } from '@floway-dev/pipeline';

export interface HttpCall {
  readonly fetcher: Fetcher;
  readonly signal: AbortSignal | undefined;
  readonly waitUntil: (work: Promise<unknown>) => void;
  readonly wrapUpstreamCall: <T>(dispatch: () => Promise<T>) => Promise<T>;
}

export type HttpServices = {
  readonly httpCall: (callId: number) => HttpCall;
};

export type HttpHeaders = readonly (readonly [string, string | Secret<string>])[];

export interface HttpRequestFacts {
  'request.http.callId': number;
  'request.http.url': string;
  'request.http.method': string;
  'request.http.headers': HttpHeaders;
  'request.http.body': HttpBody;
  'request.http.encoding': HttpBodyEncoding;
}

export interface HttpResponseExchange {
  readonly type: 'response';
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: (ReadableStream<Uint8Array> & Owned) | null;
}

export interface HttpTransportFailure {
  readonly type: 'transportFailure';
  readonly error: unknown;
}

export type HttpExchange = HttpResponseExchange | HttpTransportFailure;

export interface HttpResponseFacts {
  'response.http.exchange': HttpExchange;
  'response.http.body': (ReadableStream<Uint8Array> & Owned) | null;
}
