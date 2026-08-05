// Parse subscription-style proxy URIs into the discriminated `ProxyConfig`
// union, and serialize the same shape back out. Supported schemes: http,
// https, socks5, ss, trojan, vless.
//
// Discrimination notes:
//   * `ss://` covers both legacy AEAD-2018 (userinfo is base64(method:pwd))
//     and 2022-blake3 variants (userinfo is literal `method:base64key`).
//     We try the 2022 form first by inspecting the raw method prefix.
//   * `vless://` carries its real transport in `?type=` and `?security=`;
//     we route to `vless-tcp`, `vless-ws`, or `reality` from those.
//
// Required-field validation lives here so callers receive a typed
// `ProxyConfig` they can dial without re-checking, e.g. REALITY mandates
// pbk / sni up front.
//
// Round-trip guarantee: `parseProxyUri(formatProxyUri(c))` deep-equals `c`
// for every supported variant. The serialized string is canonical-shaped
// but not byte-for-byte identical with arbitrary inputs — query order,
// percent-encoding, and SS-2022 base64 padding may vary.

import { base64DecodeBytes, base64EncodeBytes } from './bytes.ts';
import { ProxyUriError } from './errors.ts';
import {
  type HttpProxyConfig,
  type ProxyConfig,
  type RealityProxyConfig,
  type Shadowsocks2022ProxyConfig,
  type ShadowsocksProxyConfig,
  type Socks5ProxyConfig,
  type Ss2022Method,
  type SsMethod,
  type TrojanProxyConfig,
  type VlessTcpTlsProxyConfig,
  type VlessWsTlsProxyConfig,
} from './proxy-config.ts';

const SS_METHOD_SET: ReadonlySet<string> = new Set<SsMethod>([
  'aes-128-gcm',
  'aes-256-gcm',
  'chacha20-ietf-poly1305',
]);
const SS2022_METHOD_SET: ReadonlySet<string> = new Set<Ss2022Method>([
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
]);

// Percent-decode a userinfo / fragment field, re-shaping `decodeURIComponent`'s
// raw `URIError` (thrown on a bare `%` or `%xz` sequence the WHATWG URL parser
// leaves untouched in userinfo and fragments) as a `ProxyUriError` so the
// public contract that every parse failure is `instanceof ProxyUriError` holds.
const pctDecode = (s: string, field: string): string => {
  try {
    return decodeURIComponent(s);
  } catch (cause) {
    throw new ProxyUriError(`malformed percent-encoding in ${field}`, { cause });
  }
};

export const parseProxyUri = (uri: string): ProxyConfig => {
  let url: URL;
  try {
    url = new URL(uri);
  } catch (cause) {
    throw new ProxyUriError(`malformed proxy URI: ${uri}`, { cause });
  }
  const host = url.hostname;
  const port = resolvePort(url, uri);
  const name = url.hash
    ? pctDecode(url.hash.slice(1), 'fragment')
    : `${host}:${port}`;

  switch (url.protocol) {
  case 'http:': return parseHttp(url, host, port, name, false);
  case 'https:': return parseHttp(url, host, port, name, true);
  case 'socks5:': return parseSocks5(url, host, port, name);
  case 'ss:': return parseSs(url, host, port, name);
  case 'trojan:': return parseTrojan(url, host, port, name);
  case 'vless:': return parseVless(url, host, port, name);
  default:
    throw new ProxyUriError(`unknown scheme: ${url.protocol.replace(/:$/, '')}`);
  }
};

const resolvePort = (url: URL, uri: string): number => {
  const port = readRawPort(url, uri);
  // 0 reserves the wildcard port (RFC 6335 §6); anything outside 1..65535
  // is a wire-shape failure the URL parser already accepts at the upper
  // bound for some schemes. Reject here so the dial stage's typed
  // assertValidTargetPort isn't the only line of defense, and so callers
  // see the failure at parse time instead of on first dial.
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProxyUriError(`port out of range (1..65535): ${uri}`);
  }
  return port;
};

const readRawPort = (url: URL, uri: string): number => {
  if (url.port) return Number(url.port);
  // The URL constructor strips a scheme's default port from `url.port`, so
  // `http://host:80` and `http://host` both produce `url.port === ''`.
  // Re-read the authority's port slot from the raw URI so an explicit `:80`
  // on an HTTP proxy isn't misread as "port omitted" and rejected below.
  const explicit = explicitAuthorityPort(uri);
  if (explicit !== null) return explicit;
  if (url.protocol === 'https:') return 443;
  throw new ProxyUriError(`port required: ${uri}`);
};

const explicitAuthorityPort = (uri: string): number | null => {
  const schemeEnd = uri.indexOf('://');
  if (schemeEnd < 0) return null;
  let authority = uri.slice(schemeEnd + 3);
  for (const sep of '/?#') {
    const i = authority.indexOf(sep);
    if (i >= 0) authority = authority.slice(0, i);
  }
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1);
  // Skip the IPv6 literal envelope (`[::1]`) before scanning for the port
  // colon; the colons inside the brackets aren't separators.
  const hostEnd = authority.startsWith('[') ? authority.indexOf(']') + 1 : 0;
  const colon = authority.indexOf(':', hostEnd);
  if (colon < 0) return null;
  const portStr = authority.slice(colon + 1);
  if (!/^\d+$/.test(portStr)) return null;
  return Number(portStr);
};

const parseHttp = (
  url: URL,
  host: string,
  port: number,
  name: string,
  tls: boolean,
): HttpProxyConfig => {
  const config: HttpProxyConfig = { kind: 'http', tls, host, port, name };
  if (url.username) config.username = pctDecode(url.username, 'http username');
  if (url.password) config.password = pctDecode(url.password, 'http password');
  return config;
};

const parseSocks5 = (
  url: URL,
  host: string,
  port: number,
  name: string,
): Socks5ProxyConfig => {
  const config: Socks5ProxyConfig = { kind: 'socks5', host, port, name };
  if (url.username) config.username = pctDecode(url.username, 'socks5 username');
  if (url.password) config.password = pctDecode(url.password, 'socks5 password');
  return config;
};

const parseSs = (
  url: URL,
  host: string,
  port: number,
  name: string,
): ShadowsocksProxyConfig | Shadowsocks2022ProxyConfig => {
  // SS-2022 keeps `method:base64key` as plaintext userinfo. Detect by
  // checking whether the prefix before the first ':' is a known 2022
  // method; if so, the suffix is the raw base64 key (URL parsing already
  // split userinfo on the first ':' for us via username/password, and
  // percent-encoded any `=` padding on the way through).
  const username = pctDecode(url.username, 'ss userinfo');
  if (SS2022_METHOD_SET.has(username)) {
    return {
      kind: 'ss2022',
      method: username as Ss2022Method,
      passwordBase64: pctDecode(url.password, 'ss-2022 password'),
      host,
      port,
      name,
    };
  }

  // Legacy: the entire userinfo is base64(method:password). The base64
  // alphabet contains no ':' so the URL parser leaves the whole blob in
  // url.username and never splits it across username/password. Decode
  // through the pctDecoded `username` so `=` padding (which the WHATWG
  // URL constructor percent-encodes inside userinfo) reaches the decoder raw.
  let decoded: string;
  try {
    decoded = latin1StringFromBytes(base64DecodeBytes(username));
  } catch (cause) {
    throw new ProxyUriError('malformed ss userinfo (invalid base64)', { cause });
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) throw new ProxyUriError(`malformed ss userinfo: ${username}`);
  const method = decoded.slice(0, sep);
  if (!SS_METHOD_SET.has(method)) {
    throw new ProxyUriError(`unknown ss method: ${method}`);
  }
  return {
    kind: 'ss',
    method: method as SsMethod,
    password: decoded.slice(sep + 1),
    host,
    port,
    name,
  };
};

const parseTrojan = (
  url: URL,
  host: string,
  port: number,
  name: string,
): TrojanProxyConfig => {
  const config: TrojanProxyConfig = {
    kind: 'trojan',
    password: pctDecode(url.username, 'trojan password'),
    host,
    port,
    name,
  };
  const sni = url.searchParams.get('sni');
  if (sni) config.sni = sni;
  const allowInsecure = url.searchParams.get('allowInsecure');
  if (allowInsecure !== null) config.allowInsecure = allowInsecure === '1';
  return config;
};

const parseVless = (
  url: URL,
  host: string,
  port: number,
  name: string,
): VlessTcpTlsProxyConfig | VlessWsTlsProxyConfig | RealityProxyConfig => {
  const uuid = pctDecode(url.username, 'vless uuid');
  const type = url.searchParams.get('type') ?? 'tcp';
  const security = url.searchParams.get('security') ?? 'tls';

  if (type === 'tcp' && security === 'reality') {
    const sni = url.searchParams.get('sni') ?? undefined;
    return parseReality(url, host, port, name, uuid, sni);
  }
  // Both VLESS-TCP+TLS and VLESS-WS+TLS go through the runtime's native TLS
  // via `socketDial(tls=true)`, which ties SNI to the URL host; neither
  // surface accepts an SNI override on the wire, so a `?sni=` query param
  // is silently dropped to avoid round-tripping a field the dialer cannot
  // honour. REALITY keeps `?sni=` as the spoofed front domain because its
  // userspace TLS stack drives the SNI directly.
  if (type === 'tcp' && security === 'tls') {
    const config: VlessTcpTlsProxyConfig = {
      kind: 'vless-tcp',
      uuid,
      host,
      port,
      name,
    };
    return config;
  }
  if (type === 'ws' && security === 'tls') {
    const path = url.searchParams.get('path') ?? '/';
    const config: VlessWsTlsProxyConfig = {
      kind: 'vless-ws',
      uuid,
      host,
      port,
      name,
      path,
    };
    const wsHost = url.searchParams.get('host');
    if (wsHost) config.wsHost = wsHost;
    return config;
  }
  throw new ProxyUriError(
    `unsupported vless transport: type=${type}, security=${security}`,
  );
};

const parseReality = (
  url: URL,
  host: string,
  port: number,
  name: string,
  uuid: string,
  sni: string | undefined,
): RealityProxyConfig => {
  const pbk = url.searchParams.get('pbk');
  if (!pbk) throw new ProxyUriError('reality requires pbk');
  if (!sni) throw new ProxyUriError('reality requires sni');
  const config: RealityProxyConfig = {
    kind: 'reality',
    uuid,
    host,
    port,
    name,
    publicKey: pbk,
    serverName: sni,
  };
  const sid = url.searchParams.get('sid');
  if (sid) config.shortId = sid;
  return config;
};

export const formatProxyUri = (config: ProxyConfig): string => {
  switch (config.kind) {
  case 'http': return formatHttp(config);
  case 'socks5': return formatSocks5(config);
  case 'ss': return formatSs(config);
  case 'ss2022': return formatSs2022(config);
  case 'trojan': return formatTrojan(config);
  case 'vless-tcp': return formatVlessTcp(config);
  case 'vless-ws': return formatVlessWs(config);
  case 'reality': return formatReality(config);
  default: {
    const _: never = config;
    throw new Error(`unknown ProxyConfig kind: ${(config as { kind: string }).kind}`);
  }
  }
};

const formatAuthority = (
  scheme: string,
  username: string | undefined,
  password: string | undefined,
  host: string,
  port: number,
): string => {
  let userinfo = '';
  if (username !== undefined && username !== '') {
    userinfo = encodeURIComponent(username);
    if (password !== undefined && password !== '') {
      userinfo += `:${encodeURIComponent(password)}`;
    }
    userinfo += '@';
  }
  return `${scheme}://${userinfo}${host}:${port}`;
};

const formatFragment = (name: string, host: string, port: number): string => {
  // Drop the fragment in two cases: an explicitly empty name (nothing to
  // label), or the parser's synthesized `host:port` placeholder when no
  // fragment was present on the original URL. Either way emitting a bare
  // `#` would break the round trip and surface as trailing punctuation in
  // any rendered URL.
  if (name === '' || name === `${host}:${port}`) return '';
  return `#${encodeURIComponent(name)}`;
};

const formatQuery = (params: Record<string, string | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  const s = search.toString();
  return s ? `?${s}` : '';
};

const formatHttp = (config: HttpProxyConfig): string => {
  const scheme = config.tls ? 'https' : 'http';
  const authority = formatAuthority(
    scheme, config.username, config.password, config.host, config.port,
  );
  return `${authority}${formatFragment(config.name, config.host, config.port)}`;
};

const formatSocks5 = (config: Socks5ProxyConfig): string => {
  const authority = formatAuthority(
    'socks5', config.username, config.password, config.host, config.port,
  );
  return `${authority}${formatFragment(config.name, config.host, config.port)}`;
};

const formatSs = (config: ShadowsocksProxyConfig): string => {
  // Legacy SS userinfo is the entire base64-encoded `method:password`;
  // its wire text is Latin-1, which matches every byte SS allows in either
  // field.
  const userinfo = base64EncodeBytes(latin1Bytes(`${config.method}:${config.password}`));
  return `ss://${userinfo}@${config.host}:${config.port}${
    formatFragment(config.name, config.host, config.port)}`;
};

const latin1Bytes = (value: string): Uint8Array => {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit > 0xff) throw new TypeError('Legacy Shadowsocks userinfo must contain only Latin-1 characters');
    bytes[index] = codeUnit;
  }
  return bytes;
};

const latin1StringFromBytes = (bytes: Uint8Array): string => {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return value;
};

const formatSs2022 = (config: Shadowsocks2022ProxyConfig): string => {
  // SS-2022 keeps userinfo as plaintext `method:base64key`. We emit the
  // base64 padding (`=`) raw — `parseProxyUri` decodes via
  // `decodeURIComponent`, which accepts both raw and percent-encoded `=`.
  return `ss://${config.method}:${config.passwordBase64}`
    + `@${config.host}:${config.port}${
      formatFragment(config.name, config.host, config.port)}`;
};

const formatTrojan = (config: TrojanProxyConfig): string => {
  const authority = formatAuthority(
    'trojan', config.password, undefined, config.host, config.port,
  );
  const query = formatQuery({
    sni: config.sni,
    allowInsecure: config.allowInsecure === undefined
      ? undefined
      : config.allowInsecure ? '1' : '0',
  });
  return `${authority}${query}${
    formatFragment(config.name, config.host, config.port)}`;
};

const formatVlessTcp = (config: VlessTcpTlsProxyConfig): string => {
  const authority = formatAuthority(
    'vless', config.uuid, undefined, config.host, config.port,
  );
  const query = formatQuery({
    type: 'tcp',
    security: 'tls',
  });
  return `${authority}${query}${
    formatFragment(config.name, config.host, config.port)}`;
};

const formatVlessWs = (config: VlessWsTlsProxyConfig): string => {
  const authority = formatAuthority(
    'vless', config.uuid, undefined, config.host, config.port,
  );
  const query = formatQuery({
    type: 'ws',
    security: 'tls',
    host: config.wsHost,
    path: config.path,
  });
  return `${authority}${query}${
    formatFragment(config.name, config.host, config.port)}`;
};

const formatReality = (config: RealityProxyConfig): string => {
  const authority = formatAuthority(
    'vless', config.uuid, undefined, config.host, config.port,
  );
  const query = formatQuery({
    type: 'tcp',
    security: 'reality',
    pbk: config.publicKey,
    sni: config.serverName,
    sid: config.shortId,
  });
  return `${authority}${query}${
    formatFragment(config.name, config.host, config.port)}`;
};
