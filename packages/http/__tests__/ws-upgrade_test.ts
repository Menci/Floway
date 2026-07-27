// RFC 6455 vectors covering the upgrade handshake (accept-key validation,
// non-101 reject, missing/wrong accept reject), the frame parser
// (length-form boundaries, control-frame skip, ping→pong roundtrip,
// rejection of masked server frames), and a full wire-byte round-trip
// where a fake server completes the handshake, sends a small frame, and
// the client surfaces the unmasked payload to its consumer.

import { sha1 } from '@noble/hashes/legacy.js';
import { describe, expect, it } from 'vitest';

import { makeFakeDuplex } from './test-utils.ts';
import { wsUpgradeAndFrame } from '../src/ws-upgrade.ts';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const base64 = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
};
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (u: Uint8Array): string => new TextDecoder().decode(u);

const parseUpgradeRequest = (raw: Uint8Array): { method: string; path: string; headers: Map<string, string> } => {
  const text = dec(raw);
  const idx = text.indexOf('\r\n\r\n');
  if (idx < 0) throw new Error('upgrade request not terminated');
  const lines = text.slice(0, idx).split('\r\n');
  const [method, path] = lines.shift()!.split(' ');
  const headers = new Map<string, string>();
  for (const line of lines) {
    const c = line.indexOf(':');
    headers.set(line.slice(0, c).toLowerCase(), line.slice(c + 1).trim());
  }
  return { method: method!, path: path!, headers };
};

const buildAcceptHeader = (clientKey: string): string => base64(sha1(enc(clientKey + WS_GUID)));

const standardHandshakeReply = (clientKey: string): string => {
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${buildAcceptHeader(clientKey)}`,
    '',
    '',
  ].join('\r\n');
};

const buildServerFrame = (
  opcode: number,
  payload: Uint8Array,
  fin: boolean = true,
): Uint8Array => {
  const len = payload.byteLength;
  let header: number[];
  if (len <= 125) {
    header = [(fin ? 0x80 : 0) | opcode, len];
  } else if (len <= 0xffff) {
    header = [(fin ? 0x80 : 0) | opcode, 126, (len >> 8) & 0xff, len & 0xff];
  } else {
    const hi = Math.floor(len / 0x100000000);
    const lo = len >>> 0;
    header = [
      (fin ? 0x80 : 0) | opcode, 127,
      (hi >> 24) & 0xff, (hi >> 16) & 0xff, (hi >> 8) & 0xff, hi & 0xff,
      (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff,
    ];
  }
  const out = new Uint8Array(header.length + len);
  out.set(header);
  out.set(payload, header.length);
  return out;
};

// Strip the mask + reveal the (opcode, fin, payload) of one client frame.
const parseClientFrame = (
  buf: Uint8Array,
): { opcode: number; fin: boolean; payload: Uint8Array; consumed: number } | null => {
  if (buf.byteLength < 2) return null;
  const fin = (buf[0]! & 0x80) !== 0;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  if (!masked) throw new Error('client frame is not masked');
  const len7 = buf[1]! & 0x7f;
  let off = 2;
  let payloadLen: number;
  if (len7 <= 125) {
    payloadLen = len7;
  } else if (len7 === 126) {
    if (buf.byteLength < 4) return null;
    payloadLen = (buf[2]! << 8) | buf[3]!;
    off = 4;
  } else {
    if (buf.byteLength < 10) return null;
    let n = 0;
    for (let i = 0; i < 8; i++) n = (n * 256) + buf[2 + i]!;
    payloadLen = n;
    off = 10;
  }
  if (buf.byteLength < off + 4 + payloadLen) return null;
  const maskKey = buf.subarray(off, off + 4);
  const masked_payload = buf.subarray(off + 4, off + 4 + payloadLen);
  const payload = new Uint8Array(payloadLen);
  for (let i = 0; i < payloadLen; i++) payload[i] = masked_payload[i]! ^ maskKey[i & 3]!;
  return { opcode, fin, payload, consumed: off + 4 + payloadLen };
};

describe('wsUpgradeAndFrame — handshake', () => {
  it('sends a valid GET … HTTP/1.1 upgrade with a fresh 16-byte base64 key', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'vless.local', path: '/ws' });
    // give the request bytes time to land
    await new Promise(r => setTimeout(r, 0));
    const written = fake.written();
    const req = parseUpgradeRequest(written);
    expect(req.method).toBe('GET');
    expect(req.path).toBe('/ws');
    expect(req.headers.get('host')).toBe('vless.local');
    expect(req.headers.get('upgrade')).toBe('websocket');
    expect(req.headers.get('connection')).toBe('Upgrade');
    expect(req.headers.get('sec-websocket-version')).toBe('13');
    const key = req.headers.get('sec-websocket-key')!;
    // Base64 of 16 bytes is 24 characters with `=` padding.
    expect(key).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    // Decode and check raw length is 16.
    const raw = atob(key);
    expect(raw.length).toBe(16);
    fake.respond(standardHandshakeReply(key));
    fake.endResponse();
    await upgrade;
  });

  it('accepts a 101 with the right Sec-WebSocket-Accept', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await new Promise(r => setTimeout(r, 0));
    const key = parseUpgradeRequest(fake.written()).headers.get('sec-websocket-key')!;
    fake.respond(standardHandshakeReply(key));
    await upgrade;
  });

  it('rejects a non-101 status', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await new Promise(r => setTimeout(r, 0));
    fake.respond('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
    await expect(upgrade).rejects.toMatchObject({
      name: 'HttpProtocolError',
      code: 'BAD_STATUS_LINE',
      message: expect.stringContaining('403'),
    });
  });

  it('rejects a missing Sec-WebSocket-Accept header', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await new Promise(r => setTimeout(r, 0));
    fake.respond('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    await expect(upgrade).rejects.toMatchObject({
      code: 'BAD_HEADERS',
      message: expect.stringContaining('Sec-WebSocket-Accept'),
    });
  });

  it('rejects a wrong Sec-WebSocket-Accept value', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await new Promise(r => setTimeout(r, 0));
    fake.respond([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: AAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      '',
      '',
    ].join('\r\n'));
    await expect(upgrade).rejects.toMatchObject({
      code: 'BAD_HEADERS',
      message: expect.stringContaining('Sec-WebSocket-Accept mismatch'),
    });
  });

  it('rejects a missing Upgrade: websocket header', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await new Promise(r => setTimeout(r, 0));
    const key = parseUpgradeRequest(fake.written()).headers.get('sec-websocket-key')!;
    fake.respond([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${buildAcceptHeader(key)}`,
      '',
      '',
    ].join('\r\n'));
    await expect(upgrade).rejects.toMatchObject({
      code: 'BAD_HEADERS',
      message: expect.stringContaining('Upgrade'),
    });
  });

  it('rejects a server-selected subprotocol the client did not offer', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, {
      host: 'h',
      path: '/',
      subprotocols: ['chat'],
    });
    await new Promise(r => setTimeout(r, 0));
    const key = parseUpgradeRequest(fake.written()).headers.get('sec-websocket-key')!;
    fake.respond([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${buildAcceptHeader(key)}`,
      'Sec-WebSocket-Protocol: superchat',
      '',
      '',
    ].join('\r\n'));
    await expect(upgrade).rejects.toMatchObject({
      code: 'BAD_HEADERS',
      message: expect.stringContaining('superchat'),
    });
  });

  it('rejects a caller attempt to override Host', async () => {
    const fake = makeFakeDuplex();
    await expect(wsUpgradeAndFrame(fake, {
      host: 'h',
      path: '/',
      additionalHeaders: { Host: 'other.example' },
    })).rejects.toMatchObject({
      code: 'BAD_HEADERS',
      message: expect.stringContaining('reserved'),
    });
  });

  // The path is interpolated into `GET ${path} HTTP/1.1` and the host into
  // the `Host:` line. CR/LF/SP/NUL bytes would split the request line or
  // header section and inject a forged head onto the wire — same anti-
  // smuggling defense the additionalHeaders validators close.
  const tryUpgrade = async (overrides: { host?: string; path?: string }): Promise<unknown> => {
    const fake = makeFakeDuplex();
    return await wsUpgradeAndFrame(fake, {
      host: overrides.host ?? 'h',
      path: overrides.path ?? '/',
    }).catch((e: unknown) => e);
  };

  it('rejects an empty path', async () => {
    expect(await tryUpgrade({ path: '' })).toMatchObject({ code: 'BAD_HEADERS' });
  });

  it('rejects a path containing SP (smuggling shape)', async () => {
    expect(await tryUpgrade({ path: '/hi there' })).toMatchObject({ code: 'BAD_HEADERS' });
  });

  it('rejects a path containing CR (CRLF injection prevention)', async () => {
    expect(await tryUpgrade({ path: '/foo\rEvil: 1' })).toMatchObject({ code: 'BAD_HEADERS' });
  });

  it('rejects a path containing LF (LF injection prevention)', async () => {
    expect(await tryUpgrade({ path: '/foo\nEvil: 1' })).toMatchObject({ code: 'BAD_HEADERS' });
  });

  it('rejects a path containing NUL', async () => {
    expect(await tryUpgrade({ path: '/foo\0bar' })).toMatchObject({ code: 'BAD_HEADERS' });
  });

  it('rejects a Host containing CR', async () => {
    expect(await tryUpgrade({ host: 'h\rEvil: 1' })).toMatchObject({ code: 'BAD_HEADERS' });
  });

  it('rejects a Host containing LF', async () => {
    expect(await tryUpgrade({ host: 'h\nEvil: 1' })).toMatchObject({ code: 'BAD_HEADERS' });
  });

  it('rejects a Host containing NUL', async () => {
    expect(await tryUpgrade({ host: 'h\0evil' })).toMatchObject({ code: 'BAD_HEADERS' });
  });
});

describe('wsUpgradeAndFrame — frame layer round-trip', () => {
  const completeHandshake = async (fake: ReturnType<typeof makeFakeDuplex>): Promise<void> => {
    await new Promise(r => setTimeout(r, 0));
    const key = parseUpgradeRequest(fake.written()).headers.get('sec-websocket-key')!;
    fake.respond(standardHandshakeReply(key));
  };

  // Read one client frame off `fake.written()` past any bytes already
  // consumed by the test. Returns the parsed frame and the new `seen`
  // pointer so the next call skips what's already parsed.
  const readClientFrame = async (
    fake: ReturnType<typeof makeFakeDuplex>,
    seen: number,
  ): Promise<{ frame: ReturnType<typeof parseClientFrame>; seen: number }> => {
    while (true) {
      const written = fake.written().subarray(seen);
      const f = parseClientFrame(written);
      if (f) return { frame: f, seen: seen + f.consumed };
      await new Promise(r => setTimeout(r, 5));
    }
  };

  it('round-trips a single small binary frame from server to consumer', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    fake.respond(buildServerFrame(0x2, enc('hello world')));
    const reader = stream.readable.getReader();
    const { value } = await reader.read();
    expect(dec(value!)).toBe('hello world');
    reader.releaseLock();
  });

  it('writes a single client message as one masked binary frame', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    const writer = stream.writable.getWriter();
    const handshakeBytes = fake.written().byteLength;
    await writer.write(enc('ping'));
    const { frame } = await readClientFrame(fake, handshakeBytes);
    expect(frame!.opcode).toBe(0x2);
    expect(frame!.fin).toBe(true);
    expect(dec(frame!.payload)).toBe('ping');
    writer.releaseLock();
  });

  it('responds to a server ping with a pong of the same payload', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    await upgrade;
    const handshakeBytes = fake.written().byteLength;
    fake.respond(buildServerFrame(0x9, enc('ping-payload')));
    const { frame } = await readClientFrame(fake, handshakeBytes);
    expect(frame!.opcode).toBe(0xa);
    expect(frame!.fin).toBe(true);
    expect(dec(frame!.payload)).toBe('ping-payload');
  });

  it('rejects a masked server-to-client frame', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    // Build a binary frame that happens to claim MASK=1 with a 4-byte key.
    const payload = enc('hi');
    const out = new Uint8Array(2 + 4 + payload.byteLength);
    out[0] = 0x82;
    out[1] = 0x80 | payload.byteLength;
    out.set([0, 0, 0, 0], 2);
    out.set(payload, 6);
    fake.respond(out);
    const reader = stream.readable.getReader();
    await expect(reader.read()).rejects.toMatchObject({
      code: 'BAD_HEADERS',
      message: expect.stringContaining('masked'),
    });
  });

  it('reassembles a fragmented binary message before surfacing to the consumer', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    fake.respond(buildServerFrame(0x2, enc('hello '), false));
    fake.respond(buildServerFrame(0x0, enc('world'), true));
    const reader = stream.readable.getReader();
    const { value } = await reader.read();
    expect(dec(value!)).toBe('hello world');
    reader.releaseLock();
  });

  it('handles a frame that crosses the 16-bit length boundary', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    const payload = new Uint8Array(200);
    for (let i = 0; i < payload.byteLength; i++) payload[i] = i & 0xff;
    fake.respond(buildServerFrame(0x2, payload));
    const reader = stream.readable.getReader();
    const { value } = await reader.read();
    expect(value!.byteLength).toBe(200);
    expect(value![0]).toBe(0);
    expect(value![199]).toBe(199);
    reader.releaseLock();
  });

  it('handles a frame at exactly the 7-bit length boundary (125 bytes)', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    const payload = new Uint8Array(125);
    for (let i = 0; i < 125; i++) payload[i] = i & 0xff;
    fake.respond(buildServerFrame(0x2, payload));
    const reader = stream.readable.getReader();
    const { value } = await reader.read();
    expect(value!.byteLength).toBe(125);
    reader.releaseLock();
  });

  it('handles the smallest 16-bit length frame (126 bytes)', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    const payload = new Uint8Array(126);
    fake.respond(buildServerFrame(0x2, payload));
    const reader = stream.readable.getReader();
    const { value } = await reader.read();
    expect(value!.byteLength).toBe(126);
    reader.releaseLock();
  });

  it('writes a payload that crosses the 16-bit length boundary using the 16-bit form', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    const writer = stream.writable.getWriter();
    const handshakeBytes = fake.written().byteLength;
    const payload = new Uint8Array(500);
    for (let i = 0; i < 500; i++) payload[i] = i & 0xff;
    await writer.write(payload);
    const { frame } = await readClientFrame(fake, handshakeBytes);
    expect(frame!.payload.byteLength).toBe(500);
    expect(frame!.payload[0]).toBe(0);
    expect(frame!.payload[499]).toBe(499 & 0xff);
    writer.releaseLock();
  });

  it('writes a payload above 64 KiB using the 64-bit form', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    const writer = stream.writable.getWriter();
    const handshakeBytes = fake.written().byteLength;
    const payload = new Uint8Array(70_000);
    for (let i = 0; i < payload.byteLength; i++) payload[i] = i & 0xff;
    await writer.write(payload);
    const { frame } = await readClientFrame(fake, handshakeBytes);
    expect(frame!.payload.byteLength).toBe(70_000);
    expect(frame!.payload[0]).toBe(0);
    expect(frame!.payload[69_999]).toBe(69_999 & 0xff);
    // Spot-check a couple of mid-range bytes to confirm masking is sound.
    expect(frame!.payload[12345]).toBe(12345 & 0xff);
    writer.releaseLock();
  });

  it('a server close frame ends the consumer readable cleanly', async () => {
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    fake.respond(buildServerFrame(0x8, new Uint8Array([0x03, 0xe8]))); // 1000
    const reader = stream.readable.getReader();
    const { done } = await reader.read();
    expect(done).toBe(true);
    reader.releaseLock();
  });

  it('closes the underlying transport writer after a server close frame', async () => {
    // Every server-initiated close releases the transport's write half;
    // without this teardown the underlying socket / userspace TLS stream
    // would stay locked under our frame writer until GC instead of being
    // released alongside the WS-level close.
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    await upgrade;
    fake.respond(buildServerFrame(0x8, new Uint8Array([0x03, 0xe8])));
    await fake.waitWritableClosed();
  });

  it('closes the underlying transport writer when the supplied signal aborts', async () => {
    // Every teardown event cascades the transport-writer release: the
    // signal-abort path drives the same teardown as the server-close path
    // (mirrors tls.ts's policy of releasing the writer on every exit).
    const fake = makeFakeDuplex();
    const ac = new AbortController();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/', signal: ac.signal });
    await completeHandshake(fake);
    await upgrade;
    ac.abort(new DOMException('cancelled', 'AbortError'));
    await fake.waitWritableClosed();
  });

  it('byte-truncates the abort reason so the close frame stays inside the 125-byte control-frame cap', async () => {
    // RFC 6455 §5.5: control-frame payload MUST be ≤ 125 bytes (status code
    // + reason). A reason whose UTF-8 encoding exceeds 123 bytes — easy to
    // hit with multi-byte code points, where one JS char = 4 bytes — would
    // otherwise produce a malformed close frame our own receive parser
    // rejects.
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    const handshakeBytes = fake.written().byteLength;
    // 100 emoji → 400 UTF-8 bytes — well past the 123-byte reason cap,
    // and crucially each code point is 4 bytes, so a naive mid-byte slice
    // would split a UTF-8 sequence.
    const reason = '\u{1F4A9}'.repeat(100);
    const writer = stream.writable.getWriter();
    await writer.abort(reason).catch(() => {});
    writer.releaseLock();
    const { frame } = await readClientFrame(fake, handshakeBytes);
    expect(frame!.opcode).toBe(0x8);
    expect(frame!.payload.byteLength).toBeLessThanOrEqual(125);
    expect(frame!.payload[0]).toBe(0x03); // 1011 status code high byte
    expect(frame!.payload[1]).toBe(0xf3); // 1011 status code low byte
    // The truncated reason must still decode cleanly — the truncate helper
    // walks back from the cap to the nearest UTF-8 boundary, never splitting
    // a multi-byte sequence.
    const reasonBytes = frame!.payload.subarray(2);
    expect(() => new TextDecoder('utf-8', { fatal: true }).decode(reasonBytes)).not.toThrow();
  });

  it('rejects a single-frame payload that announces more than the 64 MiB cap before draining it', async () => {
    // A rogue server can announce a 64-bit payloadLen the runtime would have
    // to buffer in full before the post-decode size check fires. Reject the
    // frame on its header alone so the reader pump never reads the bytes.
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    // 65 MiB > 64 MiB cap. Build the 10-byte 64-bit length header only;
    // the test asserts rejection happens before any payload bytes are sent.
    const announced = 65 * 1024 * 1024;
    const hi = Math.floor(announced / 0x100000000);
    const lo = announced >>> 0;
    fake.respond(new Uint8Array([
      0x82, 127,
      (hi >> 24) & 0xff, (hi >> 16) & 0xff, (hi >> 8) & 0xff, hi & 0xff,
      (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff,
    ]));
    const reader = stream.readable.getReader();
    await expect(reader.read()).rejects.toMatchObject({
      code: 'WS_MESSAGE_TOO_LARGE',
    });
  });

  it('rejects a fragmented message whose accumulated size would exceed the cap', async () => {
    // Two non-final frames each just under the cap: the first fits, the
    // second pushes the running total over.
    const fake = makeFakeDuplex();
    const upgrade = wsUpgradeAndFrame(fake, { host: 'h', path: '/' });
    await completeHandshake(fake);
    const stream = await upgrade;
    const reader = stream.readable.getReader();
    const half = 40 * 1024 * 1024;
    fake.respond(buildServerFrame(0x2, new Uint8Array(half), false));
    fake.respond(buildServerFrame(0x0, new Uint8Array(half), true));
    await expect(reader.read()).rejects.toMatchObject({
      code: 'WS_MESSAGE_TOO_LARGE',
    });
  });
});
