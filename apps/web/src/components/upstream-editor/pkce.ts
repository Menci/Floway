const encoder = new TextEncoder();

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

const random = (length: number) => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
};

export async function generatePkce() {
  const verifier = random(48);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
  return { verifier, challenge, state: random(24) };
}

const storageKey = (provider: string, kind = "oauth") => `floway-pkce:${provider}:${kind}`;

export function stashPkce(provider: string, kind: string, value: { verifier: string; state: string }) {
  sessionStorage.setItem(storageKey(provider, kind), JSON.stringify(value));
}

export function recallPkce(provider: string, kind: string, state: string) {
  const raw = sessionStorage.getItem(storageKey(provider, kind));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { verifier: string; state: string };
    return value.state === state ? value : null;
  } catch {
    return null;
  }
}

export function clearPkce(provider: string, kind: string) {
  sessionStorage.removeItem(storageKey(provider, kind));
}

export function parseCallbackPaste(text: string) {
  const value = text.trim();
  if (/^[^#\s]+#[^#\s]+$/.test(value) && !value.includes("://")) {
    const [code, state] = value.split("#");
    return { code, state };
  }
  const url = new URL(value.startsWith("?") ? `http://localhost/${value}` : value);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new Error("Callback must include code and state");
  return { code, state };
}
