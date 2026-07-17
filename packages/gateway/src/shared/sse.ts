import type { Context } from 'hono';
import { streamSSE as honoStreamSSE, type SSEStreamingApi } from 'hono/streaming';

// nginx (and OpenResty / Tengine / other nginx-based reverse proxies) enable
// `proxy_buffering` by default, which holds SSE chunks until the buffer fills
// or upstream closes — visible to end users as long, silent gaps in the
// stream. `X-Accel-Buffering: no` disables that buffering for the response.
// https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering
// Cloudflare Workers stream responses natively, so the header is a no-op
// on the Workers deployment target and fixes the Node deployment target
// when it sits behind nginx.
// https://developers.cloudflare.com/workers/runtime-apis/streams/
export const streamSSE = (
  c: Context,
  cb: (stream: SSEStreamingApi) => Promise<void>,
  onError?: (e: Error, stream: SSEStreamingApi) => Promise<void>,
): Response => {
  c.header('X-Accel-Buffering', 'no');
  return honoStreamSSE(c, cb, onError);
};
