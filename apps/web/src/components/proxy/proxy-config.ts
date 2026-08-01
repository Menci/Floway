import { errorMessage } from '../../lib/error-message';
import { DEFAULT_DIAL_DEADLINE_MS } from '@floway-dev/proxy/constants';
import type { ProxyConfig } from '@floway-dev/proxy/proxy-config';
import { parseProxyUri } from '@floway-dev/proxy/url';

export type FormKind =
  | 'http' | 'https'
  | 'socks5'
  | 'ss' | 'ss2022'
  | 'trojan'
  | 'vless-tcp' | 'vless-ws'
  | 'reality';

export const DEFAULT_DIAL_TIMEOUT_SECONDS = Math.floor(DEFAULT_DIAL_DEADLINE_MS / 1000);

export const FORM_KIND_LABELS: Record<FormKind, string> = {
  'http': 'HTTP',
  'https': 'HTTPS',
  'socks5': 'SOCKS5',
  'ss': 'Shadowsocks',
  'ss2022': 'Shadowsocks 2022',
  'trojan': 'Trojan',
  'vless-tcp': 'VLESS / TLS',
  'vless-ws': 'VLESS / WebSocket',
  'reality': 'VLESS / REALITY',
};

export const KIND_OPTIONS = (Object.keys(FORM_KIND_LABELS) as FormKind[]).map(
  value => ({ value, label: FORM_KIND_LABELS[value] }),
);

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

export const isValidPort = (n: number): boolean =>
  Number.isInteger(n) && n >= 1 && n <= 65535;

export const isValidUuid = (s: string): boolean => {
  const hex = s.replace(/-/g, '');
  return hex.length === 32 && /^[0-9a-fA-F]+$/.test(hex);
};

export const orUndef = (v: string): string | undefined => (v === '' ? undefined : v);

// Every field the proxy form can refuse, and the message it refuses with.
//
// The form renders these and the dialog's save button reads whether there are
// any, so the two cannot disagree about what a complete draft is.
export type ProxyDraftField =
  | 'name' | 'url' | 'host' | 'port'
  | 'uuid' | 'secret' | 'path' | 'serverName' | 'publicKey';

export type ProxyDraftIssues = Partial<Record<ProxyDraftField, string>>;

export const proxyDraftIssues = (draft: { config: ProxyConfig; name: string; url: string }): ProxyDraftIssues => {
  const { config } = draft;
  const required = 'dashboard.proxy.validation.required';
  const issues: ProxyDraftIssues = {};
  if (!draft.name.trim()) issues.name = 'dashboard.proxy.validation.nameRequired';
  if (!draft.url.trim()) issues.url = 'dashboard.proxy.validation.urlRequired';
  if (!config.host.trim()) issues.host = 'dashboard.proxy.validation.hostRequired';
  if (!isValidPort(config.port)) issues.port = 'dashboard.proxy.validation.portInvalid';
  switch (config.kind) {
  case 'http': case 'socks5': break;
  case 'ss': if (config.password === '') issues.secret = required; break;
  case 'ss2022': if (config.passwordBase64 === '') issues.secret = required; break;
  case 'trojan': if (config.password === '') issues.secret = required; break;
  case 'vless-tcp':
    if (!isValidUuid(config.uuid)) issues.uuid = 'dashboard.proxy.validation.uuidInvalid';
    break;
  case 'vless-ws':
    if (!isValidUuid(config.uuid)) issues.uuid = 'dashboard.proxy.validation.uuidInvalid';
    if (config.path === '') issues.path = required;
    break;
  case 'reality':
    if (!isValidUuid(config.uuid)) issues.uuid = 'dashboard.proxy.validation.uuidInvalid';
    if (config.serverName === '') issues.serverName = required;
    if (config.publicKey === '') issues.publicKey = required;
    break;
  }
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

// Never expose proxy credentials in list labels.
export const hostPortLabel = (url: string): string => {
  const parsed = parseSavedUrl(url);
  if (parsed) return `${parsed.host}:${parsed.port}`;
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString().replace(/\/\/@/, '//');
  } catch {
    return url;
  }
};

// The hue a scheme's badge is painted in. Schemes that share a transport share
// a hue -- HTTP with HTTPS, the three that tunnel a stream, the three VLESS
// shapes. The values are Fluent's own palette anchors, so they sit in the same
// family as the hues the dashboard picks by meaning for syntax highlighting;
// the badge takes a tenth of the hue for its fill and a third for its stroke,
// which is what lib/color.ts's badgeHueStyle does for every other badge.
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
