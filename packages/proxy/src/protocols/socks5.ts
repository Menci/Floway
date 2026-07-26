// SOCKS5 client (TCP CONNECT only).

import { concat, copy, encodeAtypAddress, utf8Bytes } from '../bytes.ts';
import { assertValidTargetHost, assertValidTargetPort, connectOrDialError } from '../dial-target.ts';
import { ProxyDialError } from '../errors.ts';
import type { Socks5ProxyConfig } from '../proxy-config.ts';
import type { DialOptions, DialResult, DialTarget, DialedSocket } from '../types.ts';

export const dialSocks5 = async (
  config: Socks5ProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  assertValidTargetPort(target.port, 'SOCKS5');
  assertValidTargetHost(target.host, 'SOCKS5', { maxBytes: 255 });

  const auth = config.username !== undefined
    ? { username: config.username, password: config.password ?? '' }
    : undefined;

  const socket = await connectOrDialError(options.socketDial, config.host, config.port, { signal: options.signal });

  try {
    return await dialSocks5Inner(socket, auth, target);
  } catch (err) {
    void socket.close().catch(() => {});
    throw err;
  }
};

const dialSocks5Inner = async (
  socket: DialedSocket,
  auth: { username: string; password: string } | undefined,
  target: DialTarget,
): Promise<DialResult> => {
  const writer = socket.writable.getWriter();

  const { readable: postHandshake, writable: forward } = new TransformStream<Uint8Array, Uint8Array>();
  const fwdWriter = forward.getWriter();
  const reader = socket.readable.getReader();

  let pending = new Uint8Array(0);
  const expect = async (n: number): Promise<Uint8Array> => {
    while (pending.byteLength < n) {
      const r = await reader.read();
      if (r.done) throw new ProxyDialError(`SOCKS5: unexpected EOF, want ${n} got ${pending.byteLength}`, 'proxy-handshake');
      pending = concat(pending, r.value);
    }
    const out = pending.subarray(0, n);
    pending = pending.subarray(n);
    return out;
  };

  // 1. Greeting
  const methods = auth ? [0x00, 0x02] : [0x00];
  await writer.write(new Uint8Array([0x05, methods.length, ...methods]));

  const sel = await expect(2);
  if (sel[0] !== 0x05) throw new ProxyDialError(`SOCKS5 bad version in method-select: ${sel[0]}`, 'proxy-handshake');
  if (sel[1] === 0xff) throw new ProxyDialError('SOCKS5 no acceptable methods', 'proxy-handshake');
  if (sel[1] !== 0x00 && sel[1] !== 0x02) throw new ProxyDialError(`SOCKS5 unexpected method: ${sel[1]}`, 'proxy-handshake');

  // 2. User/pass sub-negotiation
  if (sel[1] === 0x02) {
    if (!auth) throw new ProxyDialError('SOCKS5 server demanded user/pass but no creds', 'proxy-handshake');
    const u = utf8Bytes(auth.username);
    const p = utf8Bytes(auth.password);
    if (u.byteLength > 255 || p.byteLength > 255) throw new ProxyDialError('SOCKS5 cred too long', 'proxy-handshake');
    const greet = new Uint8Array(3 + u.byteLength + p.byteLength);
    let off = 0;
    greet[off++] = 0x01;
    greet[off++] = u.byteLength;
    greet.set(u, off); off += u.byteLength;
    greet[off++] = p.byteLength;
    greet.set(p, off); off += p.byteLength;
    await writer.write(greet);
    const reply = await expect(2);
    if (reply[0] !== 0x01) throw new ProxyDialError(`SOCKS5 auth bad version: ${reply[0]}`, 'proxy-handshake');
    if (reply[1] !== 0x00) throw new ProxyDialError(`SOCKS5 auth failed status=${reply[1]}`, 'proxy-handshake');
  }

  // 3. CONNECT request.
  const req = buildSocks5ConnectRequest(target.host, target.port);
  await writer.write(req);

  // 4. Reply: 4-byte fixed prefix, then variable BND.ADDR + 2-byte BND.PORT
  const head = await expect(4);
  if (head[0] !== 0x05) throw new ProxyDialError(`SOCKS5 reply bad version: ${head[0]}`, 'proxy-handshake');
  if (head[1] !== 0x00) throw new ProxyDialError(`SOCKS5 connect failed status=${head[1]}`, 'proxy-handshake');
  // RFC 1928 §6: RSV MUST be 0x00. A non-zero byte points at a broken or
  // hostile proxy and we'd rather surface the spec violation than parse
  // an ambiguous reply.
  if (head[2] !== 0x00) throw new ProxyDialError(`SOCKS5 reply RSV byte non-zero (got 0x${head[2]!.toString(16).padStart(2, '0')})`, 'proxy-handshake');
  let bndLen = 0;
  const atyp = head[3];
  if (atyp === 0x01) bndLen = 4;
  else if (atyp === 0x04) bndLen = 16;
  else if (atyp === 0x03) {
    const lenBuf = await expect(1);
    bndLen = lenBuf[0]!;
  } else throw new ProxyDialError(`SOCKS5 reply unknown ATYP: ${atyp}`, 'proxy-handshake');
  await expect(bndLen + 2);

  // 5. Forward any leftover bytes from the handshake reader to the post-handshake stream
  if (pending.byteLength) await fwdWriter.write(copy(pending));

  writer.releaseLock();

  // Pump remaining transport bytes into the forward stream. The dial's
  // outer try/catch has already exited by the time this runs, so on error
  // we ALSO close the socket — the orchestrator only holds wrapper streams
  // and has no way to reach the raw fd otherwise.
  void (async () => {
    try {
      while (true) {
        const r = await reader.read();
        if (r.done) {
          try { await fwdWriter.close(); } catch { /* fwd already closed */ }
          return;
        }
        await fwdWriter.write(copy(r.value));
      }
    } catch (e) {
      fwdWriter.abort(e).catch(() => {});
      void socket.close().catch(() => {});
    } finally {
      try { reader.releaseLock(); } catch { /* lock already released */ }
    }
  })();

  return { readable: postHandshake, writable: socket.writable };
};

/** Build a SOCKS5 CONNECT request frame (VER|CMD|RSV|ATYP+addr|port[BE]). Exported for tests. */
export const buildSocks5ConnectRequest = (host: string, port: number): Uint8Array => {
  assertValidTargetPort(port, 'SOCKS5');
  const addr = encodeAtypAddress(host, { v4: 0x01, domain: 0x03, v6: 0x04 });
  // VER | CMD=CONNECT | RSV | <ATYP+addr> | port[BE]
  const out = new Uint8Array(3 + addr.byteLength + 2);
  out[0] = 0x05; out[1] = 0x01; out[2] = 0x00;
  out.set(addr, 3);
  out[3 + addr.byteLength] = (port >> 8) & 0xff;
  out[3 + addr.byteLength + 1] = port & 0xff;
  return out;
};
