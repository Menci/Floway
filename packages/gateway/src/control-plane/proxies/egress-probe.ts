// IP-echo anchors over HTTPS. ipify and AWS checkip return v4 by default
// (when the proxy egress carries a v4 route); 6.ident.me forces v6, useful
// when an operator wants to confirm a proxy actually has a v6 path.
export const ANCHORS = {
  'ipify': { host: 'api.ipify.org', port: 443, path: '/' },
  'aws': { host: 'checkip.amazonaws.com', port: 443, path: '/' },
  'ident.me-v6': { host: '6.ident.me', port: 443, path: '/' },
} as const;

export type AnchorName = keyof typeof ANCHORS;

// IP-echo anchors return either an IPv4 in dot-notation or an IPv6 in mixed
// hex/colon (with an optional embedded IPv4 tail). Cap the response at 256
// chars before sniffing — a misbehaving anchor could otherwise feed an
// arbitrary HTML page into the test-response payload. We validate octet
// ranges and canonical v6 shape (one optional `::` shorthand, 1-4 hex
// digits per group, RFC 4291 group counts), so anchor strings like
// `999.999.999.999` or `aaaa::bbbb::cccc` cannot pass.
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
