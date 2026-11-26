import type { HttpHeader, HttpHeaders, HttpHeaderValue } from './facts.ts';
import type { FetchResponse } from './types.ts';

export const getHeader = (headers: readonly HttpHeader[], name: string): HttpHeaderValue | undefined => {
  const lowercase = name.toLowerCase();
  return headers.find(([key]) => key.toLowerCase() === lowercase)?.[1];
};

export const getHeaders = (headers: readonly HttpHeader[], name: string): HttpHeaderValue[] => {
  const lowercase = name.toLowerCase();
  return headers.filter(([key]) => key.toLowerCase() === lowercase).map(([, value]) => value);
};

export const hasHeader = (headers: readonly HttpHeader[], name: string): boolean => getHeader(headers, name) !== undefined;

export const appendHeader = (headers: readonly HttpHeader[], name: string, value: HttpHeaderValue): HttpHeaders =>
  [...headers, [name, value]];

export const setHeader = (headers: readonly HttpHeader[], name: string, value: HttpHeaderValue): HttpHeaders => {
  const lowercase = name.toLowerCase();
  const updated: HttpHeaders = [];
  let replaced = false;
  for (const entry of headers) {
    if (entry[0].toLowerCase() !== lowercase) {
      updated.push(entry);
    } else if (!replaced) {
      updated.push([entry[0], value]);
      replaced = true;
    }
  }
  if (!replaced) updated.push([name, value]);
  return updated;
};

export const filterHeaders = (headers: readonly HttpHeader[], keep: (lowercaseName: string) => boolean): HttpHeaders =>
  headers.filter(([name]) => keep(name.toLowerCase()));

export const deleteHeader = (headers: readonly HttpHeader[], name: string): HttpHeaders => {
  const lowercase = name.toLowerCase();
  return filterHeaders(headers, key => key !== lowercase);
};

export const responseHeaderEntries = ({ headers, headerLines }: FetchResponse): HttpHeaders => {
  if (headerLines !== undefined) return headerLines.map(([name, value]) => [name, value]);

  // Native Fetch combines repeated field lines other than Set-Cookie.
  // https://fetch.spec.whatwg.org/#concept-header-list-sort-and-combine
  return [...headers];
};
