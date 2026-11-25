import type { ManagedStream, Secret } from '@floway-dev/pipeline';

export type HeaderEntry = [name: string, value: string | Secret<string>];
export type HttpHeaders = HeaderEntry[];

export interface HttpStreamError {
  readonly kind: 'transport' | 'abort';
  readonly cause: unknown;
}

export type HttpBody = string | object | Uint8Array | ManagedStream<Uint8Array, HttpStreamError> | null;

export interface HttpRequestFact {
  readonly method: string;
  readonly url: string | Secret<string>;
  readonly headers: HttpHeaders;
  readonly body: HttpBody;
}

export interface HttpResponseFact {
  readonly status: number;
  readonly statusText: string;
  readonly headers: HttpHeaders;
  readonly body: HttpBody;
}
