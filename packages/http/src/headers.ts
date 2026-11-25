import type { HeaderEntry, HttpHeaders } from './facts.ts';
import type { HttpHeaderLines } from './types.ts';

export const getHeader = (headers: readonly HeaderEntry[], name: string): HeaderEntry[1] | undefined => {
  const lowercase = name.toLowerCase();
  return headers.find(([key]) => key.toLowerCase() === lowercase)?.[1];
};

export const getHeaders = (headers: readonly HeaderEntry[], name: string): HeaderEntry[1][] => {
  const lowercase = name.toLowerCase();
  return headers.filter(([key]) => key.toLowerCase() === lowercase).map(([, value]) => value);
};

export const hasHeader = (headers: readonly HeaderEntry[], name: string): boolean => getHeader(headers, name) !== undefined;

export const setHeader = (headers: readonly HeaderEntry[], name: string, value: HeaderEntry[1]): HttpHeaders => {
  const lowercase = name.toLowerCase();
  const result: HttpHeaders = [];
  let replaced = false;
  for (const header of headers) {
    if (header[0].toLowerCase() !== lowercase) result.push(header);
    else if (!replaced) {
      result.push([header[0], value]);
      replaced = true;
    }
  }
  if (!replaced) result.push([name, value]);
  return result;
};

export const appendHeader = (headers: readonly HeaderEntry[], name: string, value: HeaderEntry[1]): HttpHeaders =>
  [...headers, [name, value]];

export const filterHeaders = (headers: readonly HeaderEntry[], keep: (lowercaseName: string) => boolean): HttpHeaders =>
  headers.filter(([name]) => keep(name.toLowerCase()));

export const deleteHeader = (headers: readonly HeaderEntry[], name: string): HttpHeaders => {
  const lowercase = name.toLowerCase();
  return filterHeaders(headers, key => key !== lowercase);
};

export const materializeHeaders = (headers: readonly HeaderEntry[]): [string, string][] =>
  headers.map(([key, value]) => [key, typeof value === 'string' ? value : value.reveal()]);

const responseHeaderLines = new WeakMap<Response, HttpHeaderLines>();

export const preserveResponseHeaderLines = (response: Response, lines: HttpHeaderLines): Response => {
  responseHeaderLines.set(response, lines);
  return response;
};

export const responseHeaderEntries = (response: Response): HttpHeaders => {
  const lines = responseHeaderLines.get(response);
  if (lines) return lines.map(([name, value]) => [name, value]);

  const { headers } = response;
  const cookies = headers.getSetCookie();
  if (cookies.length === 0) return [...headers];
  let emittedCookies = false;
  const entries: HttpHeaders = [];
  for (const [name, value] of headers) {
    if (name !== 'set-cookie') entries.push([name, value]);
    else if (!emittedCookies) {
      entries.push(...cookies.map((cookie): HeaderEntry => [name, cookie]));
      emittedCookies = true;
    }
  }
  return entries;
};
