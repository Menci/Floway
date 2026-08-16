import { redirect } from 'react-router';

import type { Route } from './+types/legacy-redirects';

// Paths that existed before the dashboard was rebuilt as a React SPA. The
// current route table keeps the same surfaces under new addresses; these
// redirects keep old bookmarks and shared links working instead of falling
// through to the framework 404 page.
const LEGACY_PATHS: Record<string, string> = {
  '/login': '/',
  '/dashboard/keys': '/dashboard/services/api-keys',
  '/dashboard/models': '/dashboard/playground',
  '/dashboard/performance': '/dashboard/monitor/performance',
  '/dashboard/requests': '/dashboard/monitor/requests',
  '/dashboard/upstreams': '/dashboard/providers/upstreams',
  '/dashboard/upstreams/new': '/dashboard/providers/upstreams',
  '/dashboard/usage': '/dashboard/monitor/usage',
  '/dashboard/users': '/dashboard/admin/users',
};

export async function clientLoader({ params, request }: Route.ClientLoaderArgs) {
  const url = new URL(request.url);
  const pathname = url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;

  const staticRedirect = LEGACY_PATHS[pathname];

  let redirectTo: string | null = null;
  if (staticRedirect !== undefined) {
    redirectTo = staticRedirect;
  } else if (params.keyId !== undefined) {
    const record = url.hash.length > 1 ? `&record=${encodeURIComponent(url.hash.slice(1))}` : '';
    redirectTo = `/dashboard/monitor/requests?key=${encodeURIComponent(params.keyId)}${record}`;
  } else if (params.provider !== undefined) {
    redirectTo = `/dashboard/providers/upstreams/new/${encodeURIComponent(params.provider)}`;
  } else if (params.id !== undefined) {
    redirectTo = `/dashboard/providers/upstreams/${encodeURIComponent(params.id)}`;
  }

  if (redirectTo) throw redirect(redirectTo);
  throw new Response('Not Found', { status: 404 });
}
