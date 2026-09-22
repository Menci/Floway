import { matchPath } from 'react-router';

type LegacyRedirectParams = Record<string, string | undefined>;

interface LegacyRedirectRule {
  from: string;
  to: (params: LegacyRedirectParams, hash: string) => string;
}

const decodeParam = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    // Legacy routes were exposed through a browser router; an undecodable
    // segment is still passed through so the redirect keeps the original.
    return value;
  }
};

const recordSearch = (hash: string): string => {
  if (!hash.startsWith('#')) return '';
  const recordId = hash.slice(1);
  let decodedRecordId = recordId;
  try {
    decodedRecordId = decodeURIComponent(recordId);
  } catch {
    // Legacy hashes were written URL-encoded; an undecodable hash is still
    // passed through so the redirect keeps the original value.
  }
  return `&record=${encodeURIComponent(decodedRecordId)}`;
};

// One rule per legacy route. `from` is the absolute path pattern the old
// Vue router exposed; `to` builds the current SPA address for it. Keep this
// list ordered so static paths are tried before their parameterized
// neighbours (e.g. `/dashboard/upstreams/new` before `/dashboard/upstreams/:id`).
export const LEGACY_REDIRECT_RULES: LegacyRedirectRule[] = [
  { from: '/login', to: () => '/' },
  { from: '/dashboard/keys', to: () => '/dashboard/services/api-keys' },
  { from: '/dashboard/models', to: () => '/dashboard/playground' },
  { from: '/dashboard/performance', to: () => '/dashboard/monitor/performance' },
  { from: '/dashboard/requests', to: () => '/dashboard/monitor/requests' },
  {
    from: '/dashboard/requests/:keyId',
    to: ({ keyId = '' }, hash) =>
      `/dashboard/monitor/requests?key=${encodeURIComponent(decodeParam(keyId))}${recordSearch(hash)}`,
  },
  { from: '/dashboard/upstreams', to: () => '/dashboard/providers/upstreams' },
  { from: '/dashboard/upstreams/new', to: () => '/dashboard/providers/upstreams' },
  {
    from: '/dashboard/upstreams/new/:provider',
    to: ({ provider = '' }) => `/dashboard/providers/upstreams/new/${encodeURIComponent(decodeParam(provider))}`,
  },
  {
    from: '/dashboard/upstreams/:id',
    to: ({ id = '' }) => `/dashboard/providers/upstreams/${encodeURIComponent(decodeParam(id))}`,
  },
  { from: '/dashboard/usage', to: () => '/dashboard/monitor/usage' },
  { from: '/dashboard/users', to: () => '/dashboard/admin/users' },
];

export function legacyRedirectTarget(pathname: string, hash = ''): string | null {
  const normalized = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;

  for (const rule of LEGACY_REDIRECT_RULES) {
    const match = matchPath({ path: rule.from, end: true }, normalized);
    if (match) return rule.to(match.params, hash);
  }

  return null;
}
