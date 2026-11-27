import type { ManagedStream, Secret } from '@floway-dev/pipeline';

export type HttpHeaderValue = string | Secret<string>;
export type HttpHeader = [name: string, value: HttpHeaderValue];
export type HttpHeaders = HttpHeader[];

export interface HttpStreamError {
  kind: 'transport' | 'abort';
  cause: unknown;
}

export interface HttpRequestFact {
  url: string;
  method: string;
  headers: HttpHeaders;
  body: string | Uint8Array | object | null;
}

export interface HttpResponseFact {
  status: number;
  statusText: string;
  headers: HttpHeaders;
  body: ManagedStream<Uint8Array, HttpStreamError> | Uint8Array | null;
  startedAt?: number;
}
