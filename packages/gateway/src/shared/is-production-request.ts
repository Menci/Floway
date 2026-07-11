import type { Context } from 'hono';

import { getRuntimeKind } from '@floway-dev/platform';

// True when this request is being served by a real deployment, false
// under `wrangler dev` locally or a Node process without
// NODE_ENV=production. The signal is split per runtime because neither
// side has a portable answer:
//
// - Node: `process.env.NODE_ENV === 'production'` — the operator's
//   explicit declaration.
//
// - Cloudflare: presence of the `CF-Ray` request header. The edge always
//   attaches CF-Ray on inbound Worker requests; workerd's local inbound
//   (used by `wrangler dev`) never writes it, and miniflare does not
//   synthesize it either.
//   https://github.com/cloudflare/workerd/blob/7fa4a4bceedd2f83215a6fe584d478afbbefb0c0/src/workerd/io/io-thread-context.c%2B%2B#L28
export const isProductionRequest = (c: Context): boolean => {
  if (getRuntimeKind() === 'node') return process.env.NODE_ENV === 'production';
  return c.req.header('cf-ray') !== undefined;
};
