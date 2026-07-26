// RFC 6455 WebSocket client over a duplex byte stream.
//
// Performs the HTTP/1.1 Upgrade handshake on a transport the caller has
// already dialed (and TLS-wrapped, if needed), validates the
// Sec-WebSocket-Accept response, and returns a duplex stream of unmasked
// binary payloads. Each writable chunk goes out as one masked binary frame
// (opcode 0x2); each incoming binary or continuation-of-binary frame is
// re-assembled into a single Uint8Array and enqueued on the readable.
// Control frames are handled internally — ping → pong, close → tear down.

import { sha1 } from '@noble/hashes/legacy.js';

import { signalAbortReason } from './abort.ts';
import { base64EncodeBytes, concat, copy, utf8Bytes } from './bytes.ts';
import { HttpProtocolError } from './errors.ts';
import { STATUS_LINE, TCHAR, trimFieldValueOws, validateFieldValueBytes, validateRequestTargetBytes } from './grammar.ts';
import { readHeadSection } from './read-head-section.ts';
import type { DuplexStream } from './types.ts';

export interface WsUpgradeOptions {
  /** Value of the HTTP `Host:` header — usually the SNI / virtualhost the
   *  upstream server expects. Required because this layer doesn't know
   *  what host the duplex points at. */
  host: string;
  /** Resource path including any query string, e.g. `/ws?token=abc`. */
  path: string;
  /** Extra request headers to send with the upgrade. Names are validated
   *  as RFC 9110 tokens; values must not contain CR/LF/NUL. The handshake
   *  layer owns `Host`, `Upgrade`, `Connection`, `Sec-WebSocket-Version`,
   *  `Sec-WebSocket-Key`, and `Sec-WebSocket-Protocol` (use the
   *  `subprotocols` option instead) — supplying any of those throws. */
  additionalHeaders?: Record<string, string>;
  /** Optional `Sec-WebSocket-Protocol` value. The server's reply protocol,
   *  if any, is validated to be one of the offered protocols. */
  subprotocols?: string[];
  /** Cancellation. Aborting before or during the handshake rejects the
   *  promise, cancels the read pump, and releases the writer lock so the
   *  caller can close the underlying transport. After the handshake, the
   *  caller's ReadableStream cancel / WritableStream abort drive teardown. */
  signal?: AbortSignal;
}

// RFC 6455 §1.3 GUID concatenated with the client key to derive the
// Sec-WebSocket-Accept value.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// Reserved request-side header names this module owns. Caller-supplied
// duplicates are rejected so a hostile or buggy caller can't smuggle a
// second `Connection: keep-alive` or override our generated key.
const RESERVED_HEADER_NAMES = new Set([
  'host',
  'upgrade',
  'connection',
  'sec-websocket-version',
  'sec-websocket-key',
  'sec-websocket-protocol',
]);

// 7-bit length boundary for the short form. Above this and up to
// 0xFFFF the wire uses the 16-bit extended length; above that, the
// 64-bit extended length.
const WS_SHORT_LEN_MAX = 125;
const WS_16BIT_LEN_MAX = 0xffff;

// Cap on a single message reassembled across continuation frames, and
// equivalently on a single non-fragmented frame's payload. Without it a
// rogue server could announce a 64-bit `payloadLen` that pins unbounded
// heap before the reader pump finishes accumulating the bytes, or stream
// fragmented continuation frames indefinitely. 64 MiB is far past any
// reasonable WebSocket message a sane peer would emit.
const WS_MAX_MESSAGE_SIZE = 64 * 1024 * 1024;

// Cap on the upgrade-response head accumulation. RFC has no defined
// cap; we mirror the response parser's 64 KiB ceiling.
const WS_HEAD_BUFFER_CAP = 64 * 1024;

// Close-frame status codes per RFC 6455 §7.4.
const WS_CLOSE_NORMAL = 1000;
const WS_CLOSE_INTERNAL_ERROR = 1011;

interface FrameHeader {
  fin: boolean;
  opcode: number;
  masked: boolean;
  payloadLen: number;
  /** Total bytes consumed from the input buffer to read this header. */
  headerLen: number;
}

/**
 * Errors during the handshake throw {@link HttpProtocolError}. Errors
 * after the handshake surface on the returned readable / writable
 * (ReadableStream errored, WritableStream rejected write).
 */
export const wsUpgradeAndFrame = async (
  transport: DuplexStream,
  opts: WsUpgradeOptions,
): Promise<DuplexStream> => {
  if (opts.signal?.aborted) {
    throw signalAbortReason(opts.signal);
  }

  // Per RFC 6455 §4.1, the client key is 16 random bytes base64-encoded.
  // Generate fresh per upgrade so a replay or proxy cache can't return
  // a stale Sec-WebSocket-Accept that looks valid against an old key.
  const keyBytes = new Uint8Array(16);
  crypto.getRandomValues(keyBytes);
  const clientKey = base64EncodeBytes(keyBytes);
  const expectedAccept = base64EncodeBytes(sha1(utf8Bytes(clientKey + WS_GUID)));

  const writer = transport.writable.getWriter();
  const reader = transport.readable.getReader();

  // The pre-handshake teardown path needs to release both locks so the
  // caller can destroy the underlying socket cleanly.
  const releaseLocksAndCancel = (cause?: unknown): void => {
    void reader.cancel(cause).catch(() => {});
    try { writer.releaseLock(); } catch { /* lock already released */ }
  };

  let abortDetach: (() => void) | null = null;
  if (opts.signal) {
    const signal = opts.signal;
    const onAbort = (): void => {
      releaseLocksAndCancel(signalAbortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    abortDetach = (): void => signal.removeEventListener('abort', onAbort);
  }

  try {
    await sendUpgradeRequest(writer, opts, clientKey);

    const { headers, remainder } = await readUpgradeResponse(reader);
    validateUpgradeResponse(headers, expectedAccept, opts.subprotocols);

    abortDetach?.();
    abortDetach = null;
    writer.releaseLock();

    return frameDuplexOnTransport(
      transport,
      reader,
      remainder,
      opts.signal,
    );
  } catch (err) {
    abortDetach?.();
    releaseLocksAndCancel(err);
    throw err;
  }
};

const sendUpgradeRequest = async (
  writer: WritableStreamDefaultWriter<Uint8Array>,
  opts: WsUpgradeOptions,
  clientKey: string,
): Promise<void> => {
  // RFC 9112 §3.2 + §5: a CR/LF/SP/NUL/control byte in the path or Host
  // header would split the request line / header section and inject a
  // forged head onto the wire. Reject before serializing.
  validateRequestTargetBytes(
    opts.path,
    () => new HttpProtocolError(
      'caller-supplied WS upgrade path is empty',
      'BAD_HEADERS',
      { rfc: 'RFC 9112 §3.2' },
    ),
    hex => new HttpProtocolError(
      `caller-supplied WS upgrade path contains a forbidden byte 0x${hex}`,
      'BAD_HEADERS',
      { rfc: 'RFC 9112 §3.2' },
    ),
  );
  validateFieldValueBytes(opts.host, hex => new HttpProtocolError(
    `caller-supplied WS upgrade Host contains a forbidden control byte 0x${hex}`,
    'BAD_HEADERS',
    { rfc: 'RFC 9110 §7.2' },
  ));
  const lines: string[] = [
    `GET ${opts.path} HTTP/1.1`,
    `Host: ${opts.host}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${clientKey}`,
    'Sec-WebSocket-Version: 13',
  ];
  if (opts.subprotocols?.length) {
    lines.push(`Sec-WebSocket-Protocol: ${opts.subprotocols.join(', ')}`);
  }
  for (const [name, value] of Object.entries(opts.additionalHeaders ?? {})) {
    if (RESERVED_HEADER_NAMES.has(name.toLowerCase())) {
      throw new HttpProtocolError(
        `caller cannot override reserved WebSocket upgrade header ${JSON.stringify(name)}`,
        'BAD_HEADERS',
      );
    }
    if (!TCHAR.test(name)) {
      throw new HttpProtocolError(
        `caller-supplied WS upgrade header name is not a valid token: ${JSON.stringify(name)}`,
        'BAD_HEADERS',
        { rfc: 'RFC 9110 §5.6.2' },
      );
    }
    validateFieldValueBytes(value, hex => new HttpProtocolError(
      `caller-supplied WS upgrade header value for ${JSON.stringify(name)} contains a forbidden control byte 0x${hex}`,
      'BAD_HEADERS',
      { rfc: 'RFC 9110 §5.5' },
    ));
    lines.push(`${name}: ${value}`);
  }
  const head = `${lines.join('\r\n')}\r\n\r\n`;
  await writer.write(utf8Bytes(head));
};

interface UpgradeResponseHead {
  headers: Map<string, string>;
  remainder: Uint8Array;
}

const readUpgradeResponse = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<UpgradeResponseHead> => {
  const { statusLine, lines, remainder } = await readHeadSection(reader, new Uint8Array(0), {
    maxBytes: WS_HEAD_BUFFER_CAP,
    decodeContext: 'WS upgrade response head',
    eofError: receivedBytes => new HttpProtocolError(
      `WS upgrade: unexpected EOF before response head; got ${receivedBytes} bytes`,
      'EOF',
    ),
    overflowError: maxBytes => new HttpProtocolError(
      `WS upgrade response head exceeded ${maxBytes} bytes without a terminator`,
      'HEADER_BUFFER_OVERFLOW',
    ),
  });
  // RFC 6455 §4.1: the upgrade response is HTTP/1.1; its status code MUST
  // be 101. We surface non-101 verbatim so the caller can include the
  // server's reason phrase in a debug log.
  const m = STATUS_LINE.exec(statusLine);
  if (!m) {
    throw new HttpProtocolError(
      `WS upgrade: bad status line ${JSON.stringify(statusLine)}`,
      'BAD_STATUS_LINE',
      { rfc: 'RFC 9112 §4' },
    );
  }
  const status = parseInt(m[1]!, 10);
  if (status !== 101) {
    throw new HttpProtocolError(
      `WS upgrade replied ${status} ${JSON.stringify(m[2]!)}`,
      'BAD_STATUS_LINE',
      { rfc: 'RFC 6455 §4.1' },
    );
  }
  const headers = new Map<string, string>();
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) {
      throw new HttpProtocolError(
        `WS upgrade: header line missing colon: ${JSON.stringify(line)}`,
        'BAD_HEADERS',
        { rfc: 'RFC 9112 §5' },
      );
    }
    const name = line.slice(0, idx).toLowerCase();
    const value = trimFieldValueOws(line.slice(idx + 1));
    headers.set(name, value);
  }
  return { headers, remainder };
};

const validateUpgradeResponse = (
  headers: Map<string, string>,
  expectedAccept: string,
  offeredSubprotocols: string[] | undefined,
): void => {
  // RFC 6455 §4.1 mandates Upgrade: websocket and Connection: Upgrade.
  // Token comparisons are case-insensitive; Connection may be a comma list.
  const upgrade = headers.get('upgrade');
  if (upgrade?.toLowerCase() !== 'websocket') {
    throw new HttpProtocolError(
      `WS upgrade: missing or wrong Upgrade header: ${JSON.stringify(upgrade ?? '')}`,
      'BAD_HEADERS',
      { rfc: 'RFC 6455 §4.1' },
    );
  }
  const connection = headers.get('connection') ?? '';
  const hasUpgradeToken = connection
    .split(',')
    .map(s => s.trim().toLowerCase())
    .includes('upgrade');
  if (!hasUpgradeToken) {
    throw new HttpProtocolError(
      `WS upgrade: Connection header missing Upgrade token: ${JSON.stringify(connection)}`,
      'BAD_HEADERS',
      { rfc: 'RFC 6455 §4.1' },
    );
  }
  const accept = headers.get('sec-websocket-accept');
  if (accept !== expectedAccept) {
    throw new HttpProtocolError(
      `WS upgrade: Sec-WebSocket-Accept mismatch (got ${JSON.stringify(accept ?? '')}, expected ${JSON.stringify(expectedAccept)})`,
      'BAD_HEADERS',
      { rfc: 'RFC 6455 §4.1' },
    );
  }
  // RFC 6455 §4.1: the server's `Sec-WebSocket-Protocol` MUST be one of
  // the protocols the client offered, or absent. A server selecting a
  // protocol the client did not offer is a protocol violation.
  const selected = headers.get('sec-websocket-protocol');
  if (selected !== undefined) {
    if (!offeredSubprotocols?.includes(selected)) {
      throw new HttpProtocolError(
        `WS upgrade: server selected subprotocol ${JSON.stringify(selected)} not offered by client`,
        'BAD_HEADERS',
        { rfc: 'RFC 6455 §4.1' },
      );
    }
  }
};

const frameDuplexOnTransport = (
  transport: DuplexStream,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  initialBytes: Uint8Array,
  signal: AbortSignal | undefined,
): DuplexStream => {
  // The frame writer takes its own writer lock for the post-handshake
  // lifetime. The handshake released its writer lock before we got here.
  const frameWriter = transport.writable.getWriter();

  let plainController!: ReadableStreamDefaultController<Uint8Array>;
  let plainClosed = false;
  // A long-lived caller signal — e.g. a request controller shared across
  // many dials — would otherwise accumulate one closure per ws upgrade
  // pinning the closed-over streams.
  let detachAbortListener: (() => void) | null = null;

  const closePlain = (cause?: unknown): void => {
    if (plainClosed) return;
    plainClosed = true;
    detachAbortListener?.();
    detachAbortListener = null;
    if (cause) {
      try { plainController.error(cause); } catch { /* already closed */ }
    } else {
      try { plainController.close(); } catch { /* already closed */ }
    }
    void reader.cancel(cause).catch(() => {});
    // Close (or abort) the underlying writer too. Without this, every teardown
    // path that doesn't originate from the consumer's writable.close — server
    // close frame, transport EOF, signal abort, internal frame error — leaks
    // the transport's write half locked under our frameWriter.
    if (cause) void frameWriter.abort(cause).catch(() => {});
    else void frameWriter.close().catch(() => {});
  };

  const sendCloseFrame = async (code: number, reason: string): Promise<void> => {
    // RFC 6455 §5.5: control-frame payload MUST be ≤ 125 bytes. The 2-byte
    // status code leaves 123 bytes for the reason. Encode first, then byte-
    // truncate at a UTF-8 boundary — slicing the JS string is char-level and
    // a single multi-byte code point at the cap would split mid-sequence.
    // UTF-8 continuation bytes are 10xxxxxx (0x80..0xBF); step back from the
    // cap until we land on a byte that is either ASCII (0x00..0x7F) or a
    // leading byte (0xC0..0xFF), at which point the prefix is a complete
    // sequence of code points.
    const fullReason = utf8Bytes(reason);
    let reasonBytes: Uint8Array;
    if (fullReason.byteLength <= 123) {
      reasonBytes = fullReason;
    } else {
      let cut = 123;
      while (cut > 0 && (fullReason[cut]! & 0xc0) === 0x80) cut--;
      reasonBytes = fullReason.subarray(0, cut);
    }
    const payload = new Uint8Array(2 + reasonBytes.byteLength);
    payload[0] = (code >> 8) & 0xff;
    payload[1] = code & 0xff;
    payload.set(reasonBytes, 2);
    try {
      await writeFrame(frameWriter, 0x8, payload);
    } catch {
      /* peer already gone */
    }
  };

  // Reassembly state for fragmented messages. RFC 6455 §5.4 allows a
  // message to span FIN=0 frames followed by a FIN=1 continuation;
  // concatenate the parts and only enqueue once the message is whole. Text
  // and binary opcodes (0x1, 0x2) are reassembled identically — the framer
  // treats payloads as opaque bytes.
  let inMessage = false;
  const messageParts: Uint8Array[] = [];
  let messageSize = 0;

  const handleFrame = async (
    fin: boolean,
    opcode: number,
    payload: Uint8Array,
  ): Promise<void> => {
    if (opcode === 0x8) {
      // Close frame: respond with our own close, drain reader, signal end-
      // of-stream upward. RFC 6455 §5.5.1: the server's close payload (if
      // any) leads with a 2-byte status code followed by UTF-8 reason.
      await sendCloseFrame(WS_CLOSE_NORMAL, '');
      closePlain();
      return;
    }
    if (opcode === 0x9) {
      // Ping: per RFC 6455 §5.5.2 the pong payload echoes the ping payload.
      try { await writeFrame(frameWriter, 0xa, payload); } catch { /* peer already gone */ }
      return;
    }
    if (opcode === 0xa) {
      // Pong: we never send pings, so an unsolicited pong is informational
      // and discardable per RFC 6455 §5.5.3.
      return;
    }
    if (opcode === 0x0) {
      if (!inMessage) {
        throw new HttpProtocolError(
          'WS frame: continuation frame with no message in progress',
          'BAD_HEADERS',
          { rfc: 'RFC 6455 §5.4' },
        );
      }
    } else if (opcode === 0x1 || opcode === 0x2) {
      if (inMessage) {
        throw new HttpProtocolError(
          `WS frame: new message (opcode ${opcode}) started while a previous message was in progress`,
          'BAD_HEADERS',
          { rfc: 'RFC 6455 §5.4' },
        );
      }
      inMessage = true;
    } else {
      throw new HttpProtocolError(
        `WS frame: reserved opcode 0x${opcode.toString(16)}`,
        'BAD_HEADERS',
        { rfc: 'RFC 6455 §5.2' },
      );
    }
    messageSize += payload.byteLength;
    messageParts.push(payload);
    if (!fin) return;
    let message: Uint8Array;
    if (messageParts.length === 1) {
      message = messageParts[0]!;
    } else {
      message = new Uint8Array(messageSize);
      let off = 0;
      for (const p of messageParts) {
        message.set(p, off);
        off += p.byteLength;
      }
    }
    inMessage = false;
    messageParts.length = 0;
    messageSize = 0;
    try {
      plainController.enqueue(message);
    } catch (err) {
      closePlain(err);
    }
  };

  const readable = new ReadableStream<Uint8Array>({
    start(c) { plainController = c; },
    // A non-Error reason is a clean consumer cancel — emit a polite close
    // frame and FIN; an Error reason means the consumer hit a failure
    // mid-body, so RST the writer rather than graceful-end a half whose
    // readable just errored.
    cancel(reason) {
      plainClosed = true;
      detachAbortListener?.();
      detachAbortListener = null;
      void reader.cancel(reason).catch(() => {});
      void sendCloseFrame(WS_CLOSE_NORMAL, '').then(() => {
        if (reason instanceof Error) return frameWriter.abort(reason).catch(() => {});
        return frameWriter.close().catch(() => {});
      });
    },
  });

  void (async () => {
    let buffer: Uint8Array = initialBytes;
    try {
      while (!plainClosed) {
        const header = tryParseFrameHeader(buffer);
        if (!header) {
          const { value, done } = await reader.read();
          if (done) {
            // Transport hung up without a close frame. Treat as EOF —
            // the consumer's reader sees a clean end.
            closePlain();
            return;
          }
          buffer = concat(buffer, value);
          continue;
        }
        if (header.masked) {
          throw new HttpProtocolError(
            'WS frame: server-to-client frame is masked (RFC 6455 §5.1)',
            'BAD_HEADERS',
            { rfc: 'RFC 6455 §5.1' },
          );
        }
        // Reject an oversized data frame on its header alone, before the
        // accumulating read below pins `header.payloadLen` bytes in `buffer`.
        // Control frames (opcode ≥ 0x8) are already capped at 125 bytes by
        // tryParseFrameHeader and never enter the cross-continuation total.
        if (header.opcode < 0x8 && messageSize + header.payloadLen > WS_MAX_MESSAGE_SIZE) {
          throw new HttpProtocolError(
            `WS message exceeded ${WS_MAX_MESSAGE_SIZE} bytes across continuation frames`,
            'WS_MESSAGE_TOO_LARGE',
          );
        }
        const total = header.headerLen + header.payloadLen;
        while (buffer.byteLength < total) {
          const { value, done } = await reader.read();
          if (done) {
            throw new HttpProtocolError(
              `WS frame: unexpected EOF after ${buffer.byteLength}/${total} bytes`,
              'EOF',
            );
          }
          buffer = concat(buffer, value);
        }
        // `buffer` is `concat`'s fresh allocation (or the owned `initialBytes`
        // handed in to `frameDuplexOnTransport`, already detached by
        // `readUpgradeResponse`), so subarrays onto it are already off
        // transport-pooled memory. Copying just the remainder breaks the
        // backing-buffer aliasing between `payload` and the next iteration's
        // `buffer`; an extra `copy` on `payload` would duplicate up to
        // WS_MAX_MESSAGE_SIZE bytes per frame for no aliasing benefit.
        const payload = buffer.subarray(header.headerLen, total);
        buffer = copy(buffer.subarray(total));
        await handleFrame(header.fin, header.opcode, payload);
      }
    } catch (err) {
      closePlain(err);
    } finally {
      try { reader.releaseLock(); } catch { /* lock already released */ }
    }
  })();

  // Outbound: each chunk → one masked binary frame. RFC 6455 §5.3
  // requires every client→server frame to be masked.
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      if (chunk.byteLength === 0) return;
      await writeFrame(frameWriter, 0x2, chunk);
    },
    async close() {
      await sendCloseFrame(WS_CLOSE_NORMAL, '');
      try { await frameWriter.close(); } catch { /* peer already gone */ }
    },
    async abort(reason) {
      await sendCloseFrame(WS_CLOSE_INTERNAL_ERROR, String(reason ?? ''));
      try { await frameWriter.abort(reason); } catch { /* peer already gone */ }
    },
  });

  if (signal) {
    const captured = signal;
    const onAbort = (): void => {
      closePlain(signalAbortReason(captured));
    };
    captured.addEventListener('abort', onAbort, { once: true });
    detachAbortListener = (): void => captured.removeEventListener('abort', onAbort);
    if (captured.aborted) onAbort();
  }

  return { readable, writable };
};

// Try to parse a frame header off `buf`. Returns null if more bytes are
// needed. Throws HttpProtocolError on a structurally bad header (e.g. a
// 64-bit length with the high bit set, which RFC 6455 §5.2 forbids).
const tryParseFrameHeader = (buf: Uint8Array): FrameHeader | null => {
  if (buf.byteLength < 2) return null;
  const b0 = buf[0]!;
  const b1 = buf[1]!;
  const fin = (b0 & 0x80) !== 0;
  const rsv = b0 & 0x70;
  if (rsv !== 0) {
    throw new HttpProtocolError(
      `WS frame: non-zero reserved bits 0x${rsv.toString(16)}`,
      'BAD_HEADERS',
      { rfc: 'RFC 6455 §5.2' },
    );
  }
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  const len7 = b1 & 0x7f;
  let payloadLen: number;
  let headerLen: number;
  if (len7 <= WS_SHORT_LEN_MAX) {
    payloadLen = len7;
    headerLen = 2;
  } else if (len7 === 126) {
    if (buf.byteLength < 4) return null;
    payloadLen = (buf[2]! << 8) | buf[3]!;
    headerLen = 4;
  } else {
    if (buf.byteLength < 10) return null;
    // RFC 6455 §5.2: the 64-bit length's MSB MUST be 0. We additionally
    // refuse anything that isn't a safe integer — the JS number
    // representation is bit-exact up to 2^53 - 1 and our consumers (typed
    // arrays) cap at 2^32 anyway, so a payload above MAX_SAFE_INTEGER
    // would not survive the rest of the pipeline.
    if ((buf[2]! & 0x80) !== 0) {
      throw new HttpProtocolError(
        'WS frame: 64-bit length with MSB set',
        'BAD_HEADERS',
        { rfc: 'RFC 6455 §5.2' },
      );
    }
    let n = 0;
    for (let i = 0; i < 8; i++) n = (n * 256) + buf[2 + i]!;
    if (!Number.isSafeInteger(n)) {
      throw new HttpProtocolError(
        `WS frame: 64-bit length ${n} is not a safe integer`,
        'BAD_HEADERS',
        { rfc: 'RFC 6455 §5.2' },
      );
    }
    payloadLen = n;
    headerLen = 10;
  }
  if (masked) headerLen += 4;
  // RFC 6455 §5.5: control frames (opcodes 0x8..0xF) MUST have payload <= 125.
  if (opcode >= 0x8 && payloadLen > WS_SHORT_LEN_MAX) {
    throw new HttpProtocolError(
      `WS frame: control frame opcode 0x${opcode.toString(16)} with payload length ${payloadLen}`,
      'BAD_HEADERS',
      { rfc: 'RFC 6455 §5.5' },
    );
  }
  if (opcode >= 0x8 && !fin) {
    throw new HttpProtocolError(
      `WS frame: control frame opcode 0x${opcode.toString(16)} with FIN=0`,
      'BAD_HEADERS',
      { rfc: 'RFC 6455 §5.5' },
    );
  }
  return { fin, opcode, masked, payloadLen, headerLen };
};

const writeFrame = async (
  writer: WritableStreamDefaultWriter<Uint8Array>,
  opcode: number,
  payload: Uint8Array,
): Promise<void> => {
  const len = payload.byteLength;
  // RFC 6455 §5.3: every client-to-server frame is masked with a fresh
  // 4-byte key, XORed across the payload byte by byte.
  const maskKey = new Uint8Array(4);
  crypto.getRandomValues(maskKey);
  let headerLen: number;
  if (len <= WS_SHORT_LEN_MAX) headerLen = 2;
  else if (len <= WS_16BIT_LEN_MAX) headerLen = 4;
  else headerLen = 10;
  const frame = new Uint8Array(headerLen + 4 + len);
  frame[0] = 0x80 | (opcode & 0x0f);
  if (len <= WS_SHORT_LEN_MAX) {
    frame[1] = 0x80 | len;
  } else if (len <= WS_16BIT_LEN_MAX) {
    frame[1] = 0x80 | 126;
    frame[2] = (len >> 8) & 0xff;
    frame[3] = len & 0xff;
  } else {
    frame[1] = 0x80 | 127;
    // High 32 bits are zero — JS arithmetic stays bit-exact below 2^53,
    // so split the low 32 bits with shifts and the high 32 with division.
    const hi = Math.floor(len / 0x100000000);
    const lo = len >>> 0;
    frame[2] = (hi >> 24) & 0xff;
    frame[3] = (hi >> 16) & 0xff;
    frame[4] = (hi >> 8) & 0xff;
    frame[5] = hi & 0xff;
    frame[6] = (lo >>> 24) & 0xff;
    frame[7] = (lo >>> 16) & 0xff;
    frame[8] = (lo >>> 8) & 0xff;
    frame[9] = lo & 0xff;
  }
  frame.set(maskKey, headerLen);
  for (let i = 0; i < len; i++) {
    frame[headerLen + 4 + i] = payload[i]! ^ maskKey[i & 3]!;
  }
  await writer.write(frame);
};
