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
  'sec-websocket-extensions',
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

// RFC 6455 §10.4 requires implementations to protect themselves from a long
// stream of small fragments as well as a single large frame. Bound the number
// of retained parts independently from their total byte size.
// https://www.rfc-editor.org/rfc/rfc6455#section-10.4
const WS_MAX_MESSAGE_FRAGMENTS = 1024;

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
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = transport.readable.getReader();
  } catch (error) {
    writer.releaseLock();
    throw error;
  }

  // The pre-handshake teardown path needs to release both locks so the
  // caller can destroy the underlying socket cleanly.
  let handshakeReaderReleased = false;
  const releaseHandshakeReader = (): void => {
    if (handshakeReaderReleased) return;
    handshakeReaderReleased = true;
    try { reader.releaseLock(); } catch { /* lock already released */ }
  };
  const releaseLocksAndCancel = async (cause?: unknown): Promise<void> => {
    try { await reader.cancel(cause); } catch { /* reader already cancelled */ }
    finally { releaseHandshakeReader(); }
    try { writer.releaseLock(); } catch { /* lock already released */ }
  };

  let abortDetach: (() => void) | null = null;
  let abortHandshake: Promise<never> | null = null;
  if (opts.signal) {
    const signal = opts.signal;
    let rejectAbort!: (reason: unknown) => void;
    abortHandshake = new Promise<never>((_, reject) => { rejectAbort = reject; });
    abortHandshake.catch(() => { /* consumed by the races below */ });
    const onAbort = (): void => {
      const reason = signalAbortReason(signal);
      rejectAbort(reason);
      void reader.cancel(reason).catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    abortDetach = (): void => signal.removeEventListener('abort', onAbort);
    if (signal.aborted) onAbort();
  }

  const raceAbort = async <T>(operation: Promise<T>): Promise<T> =>
    abortHandshake ? await Promise.race([operation, abortHandshake]) : await operation;

  try {
    await raceAbort(sendUpgradeRequest(writer, opts, clientKey));

    const { headers, remainder } = await raceAbort(readUpgradeResponse(reader));
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
    const failure = opts.signal?.aborted ? signalAbortReason(opts.signal) : err;
    await releaseLocksAndCancel(failure);
    throw failure;
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
    const unique = new Set<string>();
    for (const protocol of opts.subprotocols) {
      if (!TCHAR.test(protocol) || unique.has(protocol)) {
        throw new HttpProtocolError(
          `caller-supplied WebSocket subprotocol is not a unique token: ${JSON.stringify(protocol)}`,
          'BAD_HEADERS',
          { rfc: 'RFC 6455 §4.1' },
        );
      }
      unique.add(protocol);
    }
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
  if (lines.length > 100) {
    throw new HttpProtocolError(
      `WS upgrade response has ${lines.length} header lines (max 100)`,
      'TOO_MANY_HEADERS',
    );
  }
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) {
      throw new HttpProtocolError(
        `WS upgrade: header line missing colon: ${JSON.stringify(line)}`,
        'BAD_HEADERS',
        { rfc: 'RFC 9112 §5' },
      );
    }
    const rawName = line.slice(0, idx);
    if (!TCHAR.test(rawName)) {
      throw new HttpProtocolError(
        `WS upgrade: invalid header name ${JSON.stringify(rawName)}`,
        'BAD_HEADERS',
        { rfc: 'RFC 9110 §5.1' },
      );
    }
    const name = rawName.toLowerCase();
    const value = trimFieldValueOws(line.slice(idx + 1));
    validateFieldValueBytes(value, hex => new HttpProtocolError(
      `WS upgrade: forbidden control byte 0x${hex} in ${JSON.stringify(rawName)}`,
      'BAD_HEADERS',
      { rfc: 'RFC 9110 §5.5' },
    ));
    const previous = headers.get(name);
    if (previous !== undefined) {
      if (name === 'sec-websocket-accept' || name === 'sec-websocket-protocol' || name === 'sec-websocket-extensions') {
        throw new HttpProtocolError(
          `WS upgrade: duplicate singleton header ${JSON.stringify(rawName)}`,
          'BAD_HEADERS',
          { rfc: 'RFC 6455 §11.3' },
        );
      }
      headers.set(name, `${previous}, ${value}`);
    } else {
      headers.set(name, value);
    }
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
  const extensions = headers.get('sec-websocket-extensions');
  if (extensions !== undefined) {
    throw new HttpProtocolError(
      `WS upgrade: server selected unoffered extensions ${JSON.stringify(extensions)}`,
      'BAD_HEADERS',
      { rfc: 'RFC 6455 §4.1' },
    );
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
  let readerSettlement: Promise<void> | null = null;
  const settleReader = (cause?: unknown): Promise<void> => {
    readerSettlement ??= (async () => {
      try { await reader.cancel(cause); } catch { /* reader already cancelled */ }
      finally {
        try { reader.releaseLock(); } catch { /* lock already released */ }
      }
    })();
    return readerSettlement;
  };
  let writerSettlement: Promise<void> | null = null;
  let outboundClosing = false;
  const settleFrameWriter = (cause?: unknown): Promise<void> => {
    writerSettlement ??= (async () => {
      try {
        if (cause !== undefined) await frameWriter.abort(cause);
        else await frameWriter.close();
      } catch { /* peer already gone */ }
      finally {
        try { frameWriter.releaseLock(); } catch { /* lock already released */ }
      }
    })();
    return writerSettlement;
  };

  let plainSettlement: Promise<void> | null = null;
  const closePlain = (cause?: unknown): Promise<void> => {
    if (plainSettlement) return plainSettlement;
    plainClosed = true;
    detachAbortListener?.();
    detachAbortListener = null;
    outboundClosing = true;
    plainSettlement = (async () => {
      // Settle both borrowed locks before resolving a pending consumer read.
      // This makes EOF/error a teardown certificate rather than a state that
      // can race the transport cleanup scheduled behind it.
      await Promise.all([settleReader(cause), settleFrameWriter(cause)]);
      if (cause !== undefined) {
        try { plainController.error(cause); } catch { /* already closed */ }
      } else {
        try { plainController.close(); } catch { /* already closed */ }
      }
    })();
    return plainSettlement;
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
  // and binary opcodes (0x1, 0x2) share the same byte reassembly; complete
  // text messages receive the RFC-mandated fatal UTF-8 validation.
  let inMessage = false;
  const messageParts: Uint8Array[] = [];
  let messageSize = 0;
  let messageFragments = 0;
  let messageOpcode: 0x1 | 0x2 | null = null;

  const handleFrame = async (
    fin: boolean,
    opcode: number,
    payload: Uint8Array,
  ): Promise<boolean> => {
    if (opcode === 0x8) {
      // Close frame: respond with our own close, drain reader, signal end-
      // of-stream upward. RFC 6455 §5.5.1: the server's close payload (if
      // any) leads with a 2-byte status code followed by UTF-8 reason.
      validateClosePayload(payload);
      outboundClosing = true;
      await sendCloseFrame(WS_CLOSE_NORMAL, '');
      await closePlain();
      return false;
    }
    if (opcode === 0x9) {
      // Ping: per RFC 6455 §5.5.2 the pong payload echoes the ping payload.
      await writeFrame(frameWriter, 0xa, payload);
      return false;
    }
    if (opcode === 0xa) {
      // Pong: we never send pings, so an unsolicited pong is informational
      // and discardable per RFC 6455 §5.5.3.
      return false;
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
      messageOpcode = opcode;
    } else {
      throw new HttpProtocolError(
        `WS frame: reserved opcode 0x${opcode.toString(16)}`,
        'BAD_HEADERS',
        { rfc: 'RFC 6455 §5.2' },
      );
    }
    messageFragments++;
    if (messageFragments > WS_MAX_MESSAGE_FRAGMENTS) {
      throw new HttpProtocolError(
        `WS message exceeded ${WS_MAX_MESSAGE_FRAGMENTS} fragments`,
        'WS_MESSAGE_TOO_LARGE',
      );
    }
    messageSize += payload.byteLength;
    messageParts.push(payload);
    if (!fin) return false;
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
    messageFragments = 0;
    const completeOpcode = messageOpcode;
    messageOpcode = null;
    if (completeOpcode === 0x1) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(message);
      } catch (cause) {
        throw new HttpProtocolError(
          'WS text message contains invalid UTF-8',
          'BAD_HEADERS',
          { cause, rfc: 'RFC 6455 §8.1' },
        );
      }
    }
    try {
      plainController.enqueue(message);
    } catch (err) {
      await closePlain(err);
    }
    return true;
  };

  let buffer: Uint8Array = initialBytes;
  const readable = new ReadableStream<Uint8Array>({
    start(c) { plainController = c; },
    // A non-Error reason is a clean consumer cancel — emit a polite close
    // frame and FIN; an Error reason means the consumer hit a failure
    // mid-body, so RST the writer rather than graceful-end a half whose
    // readable just errored.
    async cancel(reason) {
      if (plainClosed) return;
      plainClosed = true;
      outboundClosing = true;
      detachAbortListener?.();
      detachAbortListener = null;
      await settleReader(reason);
      await sendCloseFrame(WS_CLOSE_NORMAL, '');
      await settleFrameWriter(reason instanceof Error ? reason : undefined);
    },
    async pull(controller) {
      try {
        while (!plainClosed) {
          const header = tryParseFrameHeader(buffer);
          if (!header) {
            const { value, done } = await reader.read();
            if (done) {
              throw new HttpProtocolError(
                'WS transport ended without a Close frame',
                'EOF',
                { rfc: 'RFC 6455 §7.2.1' },
              );
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
          if (header.opcode < 0x8 && messageSize + header.payloadLen > WS_MAX_MESSAGE_SIZE) {
            throw new HttpProtocolError(
              `WS message exceeded ${WS_MAX_MESSAGE_SIZE} bytes across continuation frames`,
              'WS_MESSAGE_TOO_LARGE',
            );
          }
          const total = header.headerLen + header.payloadLen;
          const parts = [buffer];
          let bufferedBytes = buffer.byteLength;
          while (bufferedBytes < total) {
            const { value, done } = await reader.read();
            if (done) {
              throw new HttpProtocolError(
                `WS frame: unexpected EOF after ${bufferedBytes}/${total} bytes`,
                'EOF',
              );
            }
            parts.push(value);
            bufferedBytes += value.byteLength;
          }
          if (parts.length > 1) {
            const joined = new Uint8Array(bufferedBytes);
            let offset = 0;
            for (const part of parts) {
              joined.set(part, offset);
              offset += part.byteLength;
            }
            buffer = joined;
          }
          const payload = total === buffer.byteLength
            ? buffer.subarray(header.headerLen)
            : copy(buffer.subarray(header.headerLen, total));
          buffer = total === buffer.byteLength
            ? new Uint8Array(0)
            : buffer.subarray(total);
          if (await handleFrame(header.fin, header.opcode, payload)) return;
        }
      } catch (err) {
        await closePlain(err);
      }
    },
  });

  // Outbound: each chunk → one masked binary frame. RFC 6455 §5.3
  // requires every client→server frame to be masked.
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      if (outboundClosing) {
        throw new HttpProtocolError(
          'WS writable is closing; data frames are no longer allowed',
          'BAD_HEADERS',
          { rfc: 'RFC 6455 §5.5.1' },
        );
      }
      await writeFrame(frameWriter, 0x2, chunk);
    },
    async close() {
      if (outboundClosing) return;
      outboundClosing = true;
      await sendCloseFrame(WS_CLOSE_NORMAL, '');
      await settleFrameWriter();
    },
    async abort(reason) {
      if (outboundClosing) return;
      outboundClosing = true;
      await sendCloseFrame(WS_CLOSE_INTERNAL_ERROR, String(reason ?? ''));
      const cause = reason instanceof Error ? reason : new Error(String(reason ?? 'WebSocket writable aborted'));
      await closePlain(cause);
    },
  });

  if (signal) {
    const captured = signal;
    const onAbort = (): void => {
      void closePlain(signalAbortReason(captured));
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
    if (payloadLen <= WS_SHORT_LEN_MAX) {
      throw new HttpProtocolError(
        `WS frame: non-minimal 16-bit length encoding for ${payloadLen} bytes`,
        'BAD_HEADERS',
        { rfc: 'RFC 6455 §5.2' },
      );
    }
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
    if (n <= WS_16BIT_LEN_MAX) {
      throw new HttpProtocolError(
        `WS frame: non-minimal 64-bit length encoding for ${n} bytes`,
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

const validateClosePayload = (payload: Uint8Array): void => {
  if (payload.byteLength === 0) return;
  if (payload.byteLength === 1) {
    throw new HttpProtocolError(
      'WS close frame contains a one-byte status code',
      'BAD_HEADERS',
      { rfc: 'RFC 6455 §5.5.1' },
    );
  }
  const code = (payload[0]! << 8) | payload[1]!;
  if (code < 1000 || code >= 5000 || code === 1004 || code === 1005 || code === 1006 || code === 1015) {
    throw new HttpProtocolError(
      `WS close frame contains invalid status code ${code}`,
      'BAD_HEADERS',
      { rfc: 'RFC 6455 §7.4' },
    );
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(2));
  } catch (cause) {
    throw new HttpProtocolError(
      'WS close reason contains invalid UTF-8',
      'BAD_HEADERS',
      { cause, rfc: 'RFC 6455 §8.1' },
    );
  }
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
