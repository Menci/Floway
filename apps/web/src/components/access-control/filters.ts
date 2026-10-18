import { ZodError } from 'zod';

import { parsePrincipal } from './principals';
import { parseScope } from './scope';

const parseScopeFilter = (value: string | null) => {
  try {
    return parseScope(value);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError) return null;
    throw error;
  }
};

export const normalizeFilters = (source: URLSearchParams) => {
  const params = new URLSearchParams(source);
  const principal = parsePrincipal(params.get('principal') ?? '');
  const scope = parseScopeFilter(params.get('scope'));
  const invalidPrincipal = params.has('principal') && principal === null;
  const invalidScope = params.has('scope') && scope === null;
  if (invalidPrincipal) params.delete('principal');
  if (invalidScope) params.delete('scope');
  if (invalidPrincipal || invalidScope) params.delete('page');
  if (principal === null || scope === null) params.delete('effective');
  return { params, principal, scope, invalidScope };
};
