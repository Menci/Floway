import { getHeader, type HttpResponseFact } from '@floway-dev/http';

export const contentTypeOf = ({ headers }: Pick<HttpResponseFact, 'headers'>): string | undefined => {
  const contentType = getHeader(headers, 'content-type');
  return typeof contentType === 'string' ? contentType : undefined;
};
