import { redirect } from 'react-router';

import type { Route } from './+types/legacy-redirects';
import { legacyRedirectTarget } from '../lib/legacy-redirects';

export async function clientLoader({ request }: Route.ClientLoaderArgs) {
  const url = new URL(request.url);
  // React Router builds the loader Request from the URL with the hash
  // stripped, so a legacy record deep link would otherwise lose its record
  // id. Read the hash from the browser location, where it still is while the
  // redirect is being resolved.
  const hash = typeof window !== 'undefined' ? window.location.hash : url.hash;

  const redirectTo = legacyRedirectTarget(url.pathname, hash);
  if (redirectTo) throw redirect(redirectTo);
  throw new Response('Not Found', { status: 404 });
}
