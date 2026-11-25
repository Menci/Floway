import type { HttpProtocolError } from './errors.ts';
import type { ManagedStream, Secret } from '@floway-dev/pipeline';

export type HttpHeaderEntry = [name: string, value: string | Secret<string>];
export type HttpHeaders = HttpHeaderEntry[];

export interface HttpStreamError {
  kind: 'transport' | 'abort';
  cause: unknown;
}

export type HttpBodyError = HttpStreamError | { kind: 'protocol'; cause: HttpProtocolError };

export interface HttpRequestFact {
  url: string;
  method: string;
  headers: HttpHeaders;
  body: Uint8Array | null;
}

export interface HttpResponseFact {
  status: number;
  statusText: string;
  headers: HttpHeaders;
  body: ManagedStream<Uint8Array, HttpBodyError> | Uint8Array | null;
  startedAt?: number;
}
