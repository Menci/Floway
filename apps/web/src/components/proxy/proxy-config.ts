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

export type ProxyUrlParseResult =
  | { config: ProxyConfig; error: null }
  | { config: null; error: string };

export const parseProxyInput = (url: string): ProxyUrlParseResult => {
  try {
    return { config: parseProxyUri(url), error: null };
  } catch (cause) {
    return { config: null, error: errorMessage(cause) };
  }
};

export const parseSavedUrl = (url: string): ProxyConfig | null =>
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

export const KIND_COLORS: Record<string, { bg: string; fg: string }> = {
  HTTP: { bg: 'light-dark(#dbeafe, #1e3a5f)', fg: 'light-dark(#1e40af, #93c5fd)' },
  HTTPS: { bg: 'light-dark(#dbeafe, #1e3a5f)', fg: 'light-dark(#1e40af, #93c5fd)' },
  SOCKS5: { bg: 'light-dark(#d1fae5, #064e3b)', fg: 'light-dark(#065f46, #6ee7b7)' },
  SS: { bg: 'light-dark(#ede9fe, #3b1f6e)', fg: 'light-dark(#6d28d9, #c4b5fd)' },
  'SS-2022': { bg: 'light-dark(#ede9fe, #3b1f6e)', fg: 'light-dark(#6d28d9, #c4b5fd)' },
  TROJAN: { bg: 'light-dark(#ede9fe, #3b1f6e)', fg: 'light-dark(#6d28d9, #c4b5fd)' },
  VLESS: { bg: 'light-dark(#cffafe, #164e63)', fg: 'light-dark(#0e7490, #67e8f9)' },
  'VLESS-WS': { bg: 'light-dark(#cffafe, #164e63)', fg: 'light-dark(#0e7490, #67e8f9)' },
  REALITY: { bg: 'light-dark(#cffafe, #164e63)', fg: 'light-dark(#0e7490, #67e8f9)' },
};
