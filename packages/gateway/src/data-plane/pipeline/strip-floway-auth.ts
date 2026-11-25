import { stripHeaders } from '@floway-dev/provider';

const FLOWAY_AUTH_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'x-floway-session']);

export const isFlowayAuthHeader = (name: string): boolean => FLOWAY_AUTH_HEADERS.has(name.toLowerCase());

export const stripFlowayAuth = stripHeaders('serve.strip-floway-auth', name => !isFlowayAuthHeader(name));
