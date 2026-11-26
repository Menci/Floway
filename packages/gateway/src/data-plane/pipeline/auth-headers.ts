import { stripHeaders } from '@floway-dev/provider';

const authenticationHeaders = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'x-floway-session',
]);

export const stripAuthenticationHeaders = stripHeaders('strip-authentication-headers', name => !authenticationHeaders.has(name));
