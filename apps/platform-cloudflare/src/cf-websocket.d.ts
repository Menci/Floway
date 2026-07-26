// CF runtime extensions beyond the DOM WebSocket / Response types we use for
// Durable Object WebSocket Hibernation. Hand-rolled because this app
// intentionally does not depend on the full @cloudflare/workers-types
// surface; each binding declares only the methods it touches.

declare global {
  const WebSocketPair: { new (): [WebSocket, WebSocket] };

  interface ResponseInit {
    webSocket?: WebSocket;
  }

  interface Response {
    readonly webSocket?: WebSocket | null;
  }

  interface WebSocket {
    // The server side of a WebSocketPair must opt into receiving frames.
    accept(): void;
  }
}

export {};
