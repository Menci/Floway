import type { Context } from 'hono';

import { getRuntimeKind } from '@floway-dev/platform';

// True when this request is being served by a real deployment, false when
// it's `wrangler dev` locally or a Node process without NODE_ENV=production.
// The signal is split per runtime because neither side has a portable
// answer:
//
// - Node: `process.env.NODE_ENV === 'production'` is the operator's
//   explicit declaration. The Node startup gate (apps/platform-node/
//   entry.ts) refuses to boot under NODE_ENV=production with an empty
//   ADMIN_KEY; this per-request check is defence-in-depth if the process
//   ever reaches the request layer with that combination.
//
// - Cloudflare: the edge always attaches a `CF-Ray` header on inbound
//   Worker requests. workerd's local inbound (which `wrangler dev` runs
//   on) never writes it, and miniflare does not synthesize it either, so
//   the header's presence is a zero-config signal that traffic came from
//   the real edge.
//   https://github.com/cloudflare/workerd/blob/7fa4a4bceedd2f83215a6fe584d478afbbefb0c0/src/workerd/io/io-thread-context.c%2B%2B#L28
export const isProductionRequest = (c: Context): boolean => {
  if (getRuntimeKind() === 'node') return process.env.NODE_ENV === 'production';
  return c.req.header('cf-ray') !== undefined;
};
