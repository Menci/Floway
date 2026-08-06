import { utf8ByteLength } from '../../../shared/utf8.ts';

// Cloudflare rejects received WebSocket messages above 32 MiB with close code
// 1009, and buffers every accepted message before dispatching it. Matching that
// ceiling makes Node and Workers expose one transport contract. The aggregate
// budget covers both the active turn and its one permitted queued successor,
// so pipelining cannot retain more raw request bytes than one maximum message.
// https://github.com/cloudflare/cloudflare-docs/blob/f8ac0aa6d9ef268d442865225c786753aa1332af/src/content/docs/workers/runtime-apis/websockets.mdx#L153-L170
// https://github.com/cloudflare/cloudflare-docs/blob/f8ac0aa6d9ef268d442865225c786753aa1332af/src/content/docs/workers/runtime-apis/websockets.mdx#L256-L263
export const RESPONSES_WEBSOCKET_LIMITS = {
  maxMessageBytes: 32 * 1024 * 1024,
  maxPendingTurns: 2,
  maxPendingBytes: 32 * 1024 * 1024,
  maxBufferedOutputBytes: 32 * 1024 * 1024,
  maxConnectionDurationMs: 60 * 60 * 1000,
} as const;

export const RESPONSES_WEBSOCKET_CONNECTION_LIMIT_ERROR = {
  type: 'invalid_request_error',
  code: 'websocket_connection_limit_reached',
  message: 'Responses websocket connection limit reached (60 minutes). Create a new websocket connection to continue.',
} as const;

export const RESPONSES_WEBSOCKET_MESSAGE_TOO_LARGE_CODE = 'websocket_message_too_large';
export const RESPONSES_WEBSOCKET_QUEUE_LIMIT_CODE = 'websocket_queue_limit_reached';

interface ResponsesWebSocketIngressLimits {
  readonly maxMessageBytes: number;
  readonly maxPendingTurns: number;
  readonly maxPendingBytes: number;
}

export interface ResponsesWebSocketIngressReservation {
  release(): void;
}

export type ResponsesWebSocketIngressDecision =
  | { readonly kind: 'accepted'; readonly reservation: ResponsesWebSocketIngressReservation }
  | { readonly kind: 'message-too-large'; readonly byteLength: number }
  | { readonly kind: 'queue-full' };

export class ResponsesWebSocketIngressBudget {
  private pendingTurns = 0;
  private pendingBytes = 0;

  constructor(private readonly limits: ResponsesWebSocketIngressLimits = RESPONSES_WEBSOCKET_LIMITS) {}

  reserve(byteLength: number): ResponsesWebSocketIngressDecision {
    if (byteLength > this.limits.maxMessageBytes) return { kind: 'message-too-large', byteLength };
    if (
      this.pendingTurns >= this.limits.maxPendingTurns
      || this.pendingBytes + byteLength > this.limits.maxPendingBytes
    ) return { kind: 'queue-full' };

    this.pendingTurns += 1;
    this.pendingBytes += byteLength;
    let released = false;
    return {
      kind: 'accepted',
      reservation: {
        release: () => {
          if (released) return;
          released = true;
          this.pendingTurns -= 1;
          this.pendingBytes -= byteLength;
        },
      },
    };
  }
}

export type PreparedResponsesWebSocketMessage =
  | { readonly kind: 'ready'; readonly bytes: Uint8Array }
  | { readonly kind: 'unsupported'; readonly description: string }
  | { readonly kind: 'message-too-large'; readonly byteLength: number };

export const responsesWebSocketMessageByteLength = (data: unknown): number => {
  if (typeof data === 'string') return utf8ByteLength(data);
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size;
  return 0;
};

export const prepareResponsesWebSocketMessage = (
  data: unknown,
  maxMessageBytes: number = RESPONSES_WEBSOCKET_LIMITS.maxMessageBytes,
  byteLength: number = responsesWebSocketMessageByteLength(data),
): PreparedResponsesWebSocketMessage => {
  if (typeof data === 'string') {
    return byteLength > maxMessageBytes
      ? { kind: 'message-too-large', byteLength }
      : { kind: 'ready', bytes: new TextEncoder().encode(data) };
  }
  if (data instanceof ArrayBuffer) {
    return byteLength > maxMessageBytes
      ? { kind: 'message-too-large', byteLength }
      : { kind: 'ready', bytes: new Uint8Array(data.slice(0)) };
  }
  if (ArrayBuffer.isView(data)) {
    return byteLength > maxMessageBytes
      ? { kind: 'message-too-large', byteLength }
      : { kind: 'ready', bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice() };
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return byteLength > maxMessageBytes
      ? { kind: 'message-too-large', byteLength }
      : { kind: 'unsupported', description: 'Blob' };
  }
  return { kind: 'unsupported', description: typeof data };
};
