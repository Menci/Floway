import type { HttpHeaders } from '@floway-dev/http/pipeline';
import type { HttpBody, HttpBodyEncoding, HttpMultipartBody } from '@floway-dev/http/request-content';
import type { Secret } from '@floway-dev/pipeline';

export const replaceHttpHeader = (headers: HttpHeaders, name: string, value: string | Secret<string>): HttpHeaders =>
  [...headers.filter(([key]) => key.toLowerCase() !== name.toLowerCase()), [name, value]];

export const mergeHttpHeaders = (base: HttpHeaders, incoming: HttpHeaders): HttpHeaders => {
  const supplied = new Set(incoming.map(([name]) => name.toLowerCase()));
  return [...base.filter(([name]) => !supplied.has(name.toLowerCase())), ...incoming];
};

export const withHttpContentType = (headers: HttpHeaders, body: HttpBody, encoding: HttpBodyEncoding): HttpHeaders => {
  if (body === null || headers.some(([name]) => name.toLowerCase() === 'content-type')) return headers;
  if (encoding === 'multipart') {
    return [...headers, ['Content-Type', `multipart/form-data; boundary=${(body as HttpMultipartBody).boundary}`]];
  }
  return encoding === 'json' ? [...headers, ['Content-Type', 'application/json']] : headers;
};
