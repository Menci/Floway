import { WebSocketServer } from 'ws';

import { RESPONSES_WEBSOCKET_LIMITS } from '@floway-dev/gateway';

// `ws` defaults to a 100 MiB reassembled message. Floway uses Cloudflare's
// smaller 32 MiB receive ceiling as its cross-runtime contract; maxPayload
// enforces it before Node allocates the gateway's UTF-8 and parsed JSON copies.
// `ws` 8.21 also bounds fragment/chunk counts, closing the independent memory
// exhaustion class that maxPayload alone cannot stop.
// https://github.com/websockets/ws/blob/787ebf22ce3d091fb6f931d20b4c7e914ba7cf85/lib/websocket-server.js#L31-L89
// https://github.com/advisories/GHSA-96hv-2xvq-fx4p
export const createResponsesWebSocketServer = (
  maxPayload: number = RESPONSES_WEBSOCKET_LIMITS.maxMessageBytes,
): WebSocketServer => new WebSocketServer({
  noServer: true,
  maxPayload,
});
