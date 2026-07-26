// VLESS dialer composition: two transport variants for the VLESS protocol —
// TCP+TLS and WebSocket+TLS. Both run the shared VLESS framing over the
// outer transport via `vlessFrameOverStream` in vless-core.ts; the WS
// variant inserts `wsUpgradeAndFrame` between the outer TLS and the VLESS
// framing.

import { assertValidTargetHost, assertValidTargetPort, connectOrDialError } from '../dial-target.ts';
import type { VlessTcpTlsProxyConfig, VlessWsTlsProxyConfig } from '../proxy-config.ts';
import type { DialOptions, DialResult, DialTarget } from '../types.ts';
import { vlessFrameOverStream } from './vless-core.ts';
import { wsUpgradeAndFrame } from '@floway-dev/http';

export const dialVlessTcpTls = async (
  config: VlessTcpTlsProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  assertValidTargetPort(target.port, 'VLESS');
  assertValidTargetHost(target.host, 'VLESS', { maxBytes: 255 });
  const socket = await connectOrDialError(options.socketDial, config.host, config.port, { tls: true, signal: options.signal });

  try {
    return await vlessFrameOverStream(socket, config.uuid, target);
  } catch (err) {
    void socket.close().catch(() => {});
    throw err;
  }
};

export const dialVlessWsTls = async (
  config: VlessWsTlsProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  assertValidTargetPort(target.port, 'VLESS');
  assertValidTargetHost(target.host, 'VLESS', { maxBytes: 255 });
  const socket = await connectOrDialError(options.socketDial, config.host, config.port, { tls: true, signal: options.signal });

  try {
    const wsStream = await wsUpgradeAndFrame(socket, {
      host: config.wsHost ?? config.host,
      path: config.path,
      signal: options.signal,
    });
    return await vlessFrameOverStream(wsStream, config.uuid, target);
  } catch (err) {
    void socket.close().catch(() => {});
    throw err;
  }
};
