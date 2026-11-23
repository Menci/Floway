import { wrapSensitiveHeaderEntries, type HeaderEntry } from '@floway-dev/http';

export const getHeaderEntry = (headers: readonly HeaderEntry[], name: string): HeaderEntry | undefined => {
  const lowercase = name.toLowerCase();
  return headers.find(([key]) => key.toLowerCase() === lowercase);
};

export const getHeader = (headers: readonly HeaderEntry[], name: string): string | undefined => {
  const value = getHeaderEntry(headers, name)?.[1];
  return typeof value === 'string' ? value : value?.reveal();
};

export const hasHeader = (headers: readonly HeaderEntry[], name: string): boolean => getHeaderEntry(headers, name) !== undefined;

export const setHeader = (headers: readonly HeaderEntry[], name: string, value: HeaderEntry[1]): readonly HeaderEntry[] => {
  const lowercase = name.toLowerCase();
  const [replacement] = wrapSensitiveHeaderEntries([[name, value]]);
  const result: HeaderEntry[] = [];
  let replaced = false;
  for (const header of headers) {
    if (header[0].toLowerCase() !== lowercase) result.push(header);
    else if (!replaced) {
      result.push([header[0], replacement[1]]);
      replaced = true;
    }
  }
  if (!replaced) result.push(replacement);
  return result;
};

export const appendHeader = (headers: readonly HeaderEntry[], name: string, value: HeaderEntry[1]): readonly HeaderEntry[] =>
  [...headers, ...wrapSensitiveHeaderEntries([[name, value]])];

export const filterHeaders = (headers: readonly HeaderEntry[], keep: (lowercaseName: string) => boolean): readonly HeaderEntry[] =>
  headers.filter(([name]) => keep(name.toLowerCase()));

export const deleteHeader = (headers: readonly HeaderEntry[], name: string): readonly HeaderEntry[] => {
  const lowercase = name.toLowerCase();
  return filterHeaders(headers, key => key !== lowercase);
};

export const mergeHeaders = (base: readonly HeaderEntry[], additions: readonly HeaderEntry[]): readonly HeaderEntry[] =>
  additions.reduce((headers, [name, value]) => setHeader(headers, name, value), base);
