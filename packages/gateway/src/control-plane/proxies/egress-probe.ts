import { ProxyDialError, type ProxyConfig, type SocketDial } from '@floway-dev/proxy';

// IP-echo anchors over HTTPS. ipify and AWS checkip return v4 by default
// (when the proxy egress carries a v4 route); 6.ident.me forces v6, useful
// when an operator wants to confirm a proxy actually has a v6 path.
export const ANCHORS = {
  'ipify': { host: 'api.ipify.org', port: 443, path: '/' },
  'aws': { host: 'checkip.amazonaws.com', port: 443, path: '/' },
  'ident.me-v6': { host: '6.ident.me', port: 443, path: '/' },
} as const;

export type AnchorName = keyof typeof ANCHORS;

type RunProxiedRequest = typeof import('@floway-dev/proxy').runProxiedRequest;

export interface EgressProbeDependencies {
  runProxiedRequest: RunProxiedRequest;
  socketDial: SocketDial;
}

interface EgressProbeInput {
  config: ProxyConfig;
  anchorName: AnchorName;
  dialTimeoutSeconds?: number | null;
}

export type EgressProbeResult =
  | { ok: true; egress_ip: string }
  | { ok: false; error: string };

const PROBE_BODY_LIMIT_BYTES = 256;

// Read only the prefix that can reach the validation/error surface. Cancelling
// at the boundary also tears down a peer that keeps streaming after the useful
// bytes, so a broken echo service cannot retain a socket or grow our heap.
const readProbeBodyPrefix = async (response: Response): Promise<string> => {
  if (response.body === null) return '';

  const reader = response.body.getReader();
  const bytes = new Uint8Array(PROBE_BODY_LIMIT_BYTES);
  let length = 0;
  try {
    while (length < bytes.byteLength) {
      const result = await reader.read();
      if (result.done) break;
      const copyLength = Math.min(result.value.byteLength, bytes.byteLength - length);
      bytes.set(result.value.subarray(0, copyLength), length);
      length += copyLength;
    }
    if (length === bytes.byteLength) {
      await reader.cancel(`proxy probe response body reached ${PROBE_BODY_LIMIT_BYTES}-byte limit`);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(bytes.subarray(0, length));
};

export const probeProxyEgress = async (
  input: EgressProbeInput,
  dependencies: EgressProbeDependencies,
): Promise<EgressProbeResult> => {
  const anchor = ANCHORS[input.anchorName];
  try {
    const response = await dependencies.runProxiedRequest(
      input.config,
      { host: anchor.host, port: anchor.port, tls: true },
      {
        method: 'GET',
        path: anchor.path,
        headers: { 'User-Agent': 'floway-proxy-test/1' },
      },
      {
        socketDial: dependencies.socketDial,
        ...(input.dialTimeoutSeconds == null ? {} : { dialTimeoutMs: input.dialTimeoutSeconds * 1000 }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel(`proxy probe anchor returned status ${response.status}`);
      return { ok: false, error: `anchor returned status ${response.status}` };
    }

    const truncated = (await readProbeBodyPrefix(response)).trim();
    if (!isIpV4(truncated) && !isIpV6(truncated)) {
      return { ok: false, error: `anchor returned non-IP body: ${truncated.slice(0, 80)}` };
    }
    // The v6-only DNS name normally prevents a v4 response. Keep the shape
    // check for DNS64/NAT64 deployments and for an upstream record change.
    if (input.anchorName === 'ident.me-v6' && !truncated.includes(':')) {
      return { ok: false, error: `v6 anchor returned a v4 address (${truncated}); proxy has no v6 path` };
    }
    return { ok: true, egress_ip: truncated };
  } catch (error) {
    if (error instanceof ProxyDialError) {
      return { ok: false, error: `[${error.stage}] ${error.message}` };
    }
    throw error;
  }
};

// IP-echo anchors return either an IPv4 in dot-notation or an IPv6 in mixed
// hex/colon (with an optional embedded IPv4 tail). Validate octet ranges and
// canonical v6 shape so an HTML page or malformed address cannot pass.
export const isIpV4 = (s: string): boolean => {
  const octets = s.split('.');
  if (octets.length !== 4) return false;
  for (const o of octets) {
    if (!/^\d{1,3}$/.test(o)) return false;
    // Reject leading zeros (e.g. `01`) — RFC 3986 forbids them and some
    // resolvers interpret the value as octal, so accepting them invites
    // ambiguity.
    if (o.length > 1 && o.startsWith('0')) return false;
    const n = Number(o);
    if (n > 255) return false;
  }
  return true;
};

export const isIpV6 = (s: string): boolean => {
  if (!s.includes(':')) return false;
  // At most one `::` shorthand (per RFC 4291 §2.2).
  if ((s.match(/::/g) ?? []).length > 1) return false;
  if (s.includes(':::')) return false;

  // Normalize an embedded v4 tail to two synthetic hex groups so the rest
  // of the validation runs on a pure-hex shape.
  let normalized = s;
  const lastColon = s.lastIndexOf(':');
  const afterLastColon = s.slice(lastColon + 1);
  if (afterLastColon.includes('.')) {
    if (!isIpV4(afterLastColon)) return false;
    normalized = `${s.slice(0, lastColon + 1)}0:0`;
  }

  const validGroup = (g: string): boolean => /^[0-9a-fA-F]{1,4}$/.test(g);

  if (normalized.includes('::')) {
    const [leftRaw, rightRaw] = normalized.split('::');
    const left = leftRaw === '' ? [] : leftRaw.split(':');
    const right = rightRaw === '' ? [] : rightRaw.split(':');
    if (!left.every(validGroup) || !right.every(validGroup)) return false;
    // `::` must elide at least one group, so the explicit group total
    // is strictly less than 8.
    return left.length + right.length < 8;
  }

  const groups = normalized.split(':');
  if (groups.length !== 8) return false;
  return groups.every(validGroup);
};
