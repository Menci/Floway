import type { UpstreamProviderKind } from '@floway-dev/provider/model';

const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

const random = (length: number) => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
};

export const generatePkce = async () => {
  const verifier = random(48);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
  return { verifier, challenge, state: random(24) };
};

const storageKey = (kind: UpstreamProviderKind, flowKind: string) => `floway-pkce:${kind}:${flowKind}`;

export const stashPkce = (kind: UpstreamProviderKind, flowKind: string, value: { verifier: string; state: string }) => {
  sessionStorage.setItem(storageKey(kind, flowKind), JSON.stringify(value));
};

export const recallPkce = (kind: UpstreamProviderKind, flowKind: string, state: string) => {
  const raw = sessionStorage.getItem(storageKey(kind, flowKind));
  if (!raw) return null;
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object') throw new TypeError('Stored PKCE state must be an object');
  const record = value as Record<string, unknown>;
  if (typeof record.verifier !== 'string' || typeof record.state !== 'string') {
    throw new TypeError('Stored PKCE state must contain verifier and state strings');
  }
  return record.state === state
    ? { verifier: record.verifier, state: record.state }
    : null;
};

export const clearPkce = (kind: UpstreamProviderKind, flowKind: string) => {
  sessionStorage.removeItem(storageKey(kind, flowKind));
};

export const parseCallbackPaste = (text: string) => {
  const value = text.trim();
  if (/^[^#\s]+#[^#\s]+$/.test(value) && !value.includes('://')) {
    const [code, state] = value.split('#');
    return { code, state };
  }
  const url = new URL(value.startsWith('?') ? `http://localhost/${value}` : value);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) throw new Error('Callback must include code and state');
  return { code, state };
};
