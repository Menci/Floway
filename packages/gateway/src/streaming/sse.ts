import type { Context } from 'hono';
// eslint-disable-next-line no-restricted-imports -- the whole point of this wrapper is to funnel every streamSSE call through here.
import { streamSSE as honoStreamSSE, type SSEStreamingApi } from 'hono/streaming';

// nginx (and OpenResty / Tengine / other nginx-based reverse proxies) enable
// `proxy_buffering` by default, which holds SSE chunks until the buffer fills
// or upstream closes — visible to end users as long, silent gaps in the
// stream. `X-Accel-Buffering: no` disables that buffering for the response.
// Cloudflare's edge ignores the header, so it costs nothing on the Workers
// deployment target and fixes the Node deployment target when it sits behind
// nginx.
export type { SSEStreamingApi };

export const streamSSE = (
  c: Context,
  cb: (stream: SSEStreamingApi) => Promise<void>,
  onError?: (e: Error, stream: SSEStreamingApi) => Promise<void>,
): Response => {
  c.header('X-Accel-Buffering', 'no');
  return honoStreamSSE(c, cb, onError);
};
