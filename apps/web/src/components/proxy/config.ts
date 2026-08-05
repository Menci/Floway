import { errorMessage } from '../../lib/error-message';
import { DEFAULT_DIAL_DEADLINE_MS } from '@floway-dev/proxy/constants';
import type { ProxyConfig } from '@floway-dev/proxy/proxy-config';
import { formatProxyUri, parseProxyUri } from '@floway-dev/proxy/url';

export type FormKind =
  | 'http' | 'https'
  | 'socks5'
  | 'ss' | 'ss2022'
  | 'trojan'
  | 'vless-tcp' | 'vless-ws'
  | 'reality';

export const DEFAULT_DIAL_TIMEOUT_SECONDS = Math.floor(DEFAULT_DIAL_DEADLINE_MS / 1000);

export const FORM_KINDS: FormKind[] = [
  'http', 'https',
  'socks5',
  'ss', 'ss2022',
  'trojan',
  'vless-tcp', 'vless-ws',
  'reality',
];

export const formKindLabelKey = <K extends FormKind>(kind: K): `dashboard.proxy.form.protocolOptions.${K}` =>
  `dashboard.proxy.form.protocolOptions.${kind}`;

export const SS_METHOD_OPTIONS = [
  { value: 'aes-128-gcm' as const, label: 'aes-128-gcm' },
  { value: 'aes-256-gcm' as const, label: 'aes-256-gcm' },
  { value: 'chacha20-ietf-poly1305' as const, label: 'chacha20-ietf-poly1305' },
];

export const SS2022_METHOD_OPTIONS = [
  { value: '2022-blake3-aes-128-gcm' as const, label: '2022-blake3-aes-128-gcm' },
  { value: '2022-blake3-aes-256-gcm' as const, label: '2022-blake3-aes-256-gcm' },
  { value: '2022-blake3-chacha20-poly1305' as const, label: '2022-blake3-chacha20-poly1305' },
];

export const defaultsFor = (
  kind: FormKind,
  ctx: { host: string; port: number; name: string },
): ProxyConfig => {
  const port =
    ctx.port > 0
      ? ctx.port
      : ((k: FormKind) => {
          switch (k) {
          case 'http': return 8080;
          case 'https': case 'trojan': case 'vless-tcp': case 'vless-ws': case 'reality': return 443;
          case 'socks5': return 1080;
          case 'ss': case 'ss2022': return 8388;
          }
        })(kind);
  const base = { host: ctx.host, port, name: ctx.name };
  switch (kind) {
  case 'http': return { kind: 'http', tls: false, ...base };
  case 'https': return { kind: 'http', tls: true, ...base };
  case 'socks5': return { kind: 'socks5', ...base };
  case 'ss': return { kind: 'ss', method: 'aes-256-gcm' as const, password: '', ...base };
  case 'ss2022': return { kind: 'ss2022', method: '2022-blake3-aes-128-gcm' as const, passwordBase64: '', ...base };
  case 'trojan': return { kind: 'trojan', password: '', ...base };
  case 'vless-tcp': return { kind: 'vless-tcp', uuid: '', ...base };
  case 'vless-ws': return { kind: 'vless-ws', uuid: '', path: '/', ...base };
  case 'reality': return { kind: 'reality', uuid: '', publicKey: '', serverName: '', ...base };
  }
};

export const formKindFromConfig = (c: ProxyConfig): FormKind => {
  if (c.kind === 'http') return c.tls ? 'https' : 'http';
  return c.kind;
};

const isValidPort = (n: number): boolean =>
  Number.isInteger(n) && n >= 1 && n <= 65535;

const isValidUuid = (s: string): boolean => {
  const hex = s.replace(/-/g, '');
  return hex.length === 32 && /^[0-9a-fA-F]+$/.test(hex);
};

export const orUndef = (v: string): string | undefined => (v === '' ? undefined : v);

export interface ProxyFormValues {
  config: ProxyConfig;
  dialTimeout: string;
  name: string;
  // Null until the operator types a URL; the field then shows the URI the
  // structured inputs build.
  url: string | null;
}

// The structured inputs and the URI field are two views of one proxy, so the URI
// the form validates and submits is whichever of them the operator last touched.
export const proxyDraftUrl = (values: ProxyFormValues): string =>
  values.url ?? (values.config.host.trim()
    ? formatProxyUri({ ...values.config, name: values.name.trim() })
    : '');

// Every issue sits at the path its value occupies in the form, so a scoped
// react-hook-form revalidation reaches it.
export const PROXY_CONFIG_ISSUE_FIELDS = [
  'host', 'port', 'uuid', 'password', 'passwordBase64', 'path', 'serverName', 'publicKey',
] as const;

export type ProxyConfigIssueField = typeof PROXY_CONFIG_ISSUE_FIELDS[number];

export interface ProxyDraftIssues {
  config: Partial<Record<ProxyConfigIssueField, string>>;
  dialTimeout?: string;
  name?: string;
  url?: string;
}

export const proxyDraftIssues = (values: ProxyFormValues): ProxyDraftIssues => {
  const { config } = values;
  const required = 'dashboard.proxy.validation.required';
  const issues: ProxyDraftIssues = { config: {} };
  const url = proxyDraftUrl(values).trim();
  if (!values.name.trim()) issues.name = 'dashboard.proxy.validation.nameRequired';
  // A parse failure outranks the draft's "still empty": there is text in the
  // field, and what is wrong is the text.
  if (!url) issues.url = 'dashboard.proxy.validation.urlRequired';
  else issues.url = parseProxyInput(url).error ?? undefined;
  if (!config.host.trim()) issues.config.host = 'dashboard.proxy.validation.hostRequired';
  if (!isValidPort(config.port)) issues.config.port = 'dashboard.proxy.validation.portInvalid';
  switch (config.kind) {
  case 'http': case 'socks5': break;
  case 'ss': if (config.password === '') issues.config.password = required; break;
  case 'ss2022': if (config.passwordBase64 === '') issues.config.passwordBase64 = required; break;
  case 'trojan': if (config.password === '') issues.config.password = required; break;
  case 'vless-tcp':
    if (!isValidUuid(config.uuid)) issues.config.uuid = 'dashboard.proxy.validation.uuidInvalid';
    break;
  case 'vless-ws':
    if (!isValidUuid(config.uuid)) issues.config.uuid = 'dashboard.proxy.validation.uuidInvalid';
    if (config.path === '') issues.config.path = required;
    break;
  case 'reality':
    if (!isValidUuid(config.uuid)) issues.config.uuid = 'dashboard.proxy.validation.uuidInvalid';
    if (config.serverName === '') issues.config.serverName = required;
    if (config.publicKey === '') issues.config.publicKey = required;
    break;
  }
  const timeout = parseDialTimeoutInput(values.dialTimeout);
  if (timeout.error) issues.dialTimeout = `dashboard.proxy.validation.timeout.${timeout.error}`;
  return issues;
};

export type ProxyUrlParseResult =
  | { config: ProxyConfig; error: null }
  | { config: null; error: string };

export const parseProxyInput = (url: string): ProxyUrlParseResult => {
  try {
    return { config: parseProxyUri(url), error: null };
  } catch (error) {
    return { config: null, error: errorMessage(error) };
  }
};

const parseSavedUrl = (url: string): ProxyConfig | null =>
  parseProxyInput(url).config;

export type DialTimeoutResult =
  | { value: number | null; error: null }
  | { value: null; error: 'positive' | 'maximum' };

export const parseDialTimeoutInput = (raw: string): DialTimeoutResult => {
  const trimmed = raw.trim();
  if (trimmed === '') return { value: null, error: null };
  if (!/^[1-9][0-9]*$/.test(trimmed)) return { value: null, error: 'positive' };
  const value = Number(trimmed);
  return value <= 600
    ? { value, error: null }
    : { value: null, error: 'maximum' };
};

export const proxyUrlPlaceholder = (config: ProxyConfig): string => {
  switch (formKindFromConfig(config)) {
  case 'http': return 'http://user:pass@host:8080';
  case 'https': return 'https://user:pass@host:443';
  case 'socks5': return 'socks5://user:pass@host:1080';
  case 'ss': return 'ss://method:password@host:8388';
  case 'ss2022': return 'ss://2022-blake3-aes-128-gcm:base64-key@host:8388';
  case 'trojan': return 'trojan://password@host:443?sni=server.example.com';
  case 'vless-tcp': return 'vless://uuid@host:443?type=tcp&security=tls&sni=server.example.com';
  case 'vless-ws': return 'vless://uuid@host:443?type=ws&security=tls&sni=server.example.com&path=/ws';
  case 'reality': return 'vless://uuid@host:443?type=tcp&security=reality&pbk=...&sni=...&sid=...';
  }
};

// Never expose proxy credentials in list labels. A stored URL therefore either
// reduces to an address -- the parsed host and port, or the authority minus its
// userinfo for a scheme this build cannot parse -- or it gets no label at all,
// because every remaining rendering of it carries the password it was written
// with.
export const hostPortLabel = (url: string): string | null => {
  const parsed = parseSavedUrl(url);
  if (parsed) return `${parsed.host}:${parsed.port}`;
  try {
    const { host } = new URL(url);
    return host === '' ? null : host;
  } catch {
    return null;
  }
};

// Schemes sharing a transport share a hue; the values are Fluent's palette anchors.
export const KIND_HUES: Record<string, string> = {
  HTTP: '#0f6cbd',
  HTTPS: '#0f6cbd',
  SOCKS5: '#107c10',
  SS: '#8764b8',
  'SS-2022': '#8764b8',
  TROJAN: '#8764b8',
  VLESS: '#038387',
  'VLESS-WS': '#038387',
  REALITY: '#038387',
};
