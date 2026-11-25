import type { HeaderEntry, HttpHeaders } from './facts.ts';

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

export const responseHeaderEntries = ({ headers }: Response): HttpHeaders => {
  const cookies = headers.getSetCookie();
  const entries: HttpHeaders = [];
  for (const [name, value] of headers) {
    if (name !== 'set-cookie') entries.push([name, value]);
    else if (cookies.length > 0) {
      entries.push(...cookies.splice(0).map((cookie): HeaderEntry => [name, cookie]));
    }
  }
  return entries;
};
