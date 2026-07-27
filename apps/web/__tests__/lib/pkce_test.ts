import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { clearPkce, deriveChallenge, generatePkce, parseCallbackPaste, peekStashedPkce, pkceStorageKey, recallPkce, stashPkce } from '../../src/lib/pkce.ts';

// The web tests run in the default Vitest node environment, which has no
// `sessionStorage`. Install a minimal in-memory shim so the storage helpers
// exercise their real `sessionStorage.{getItem,setItem,removeItem}` calls.
beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size; },
    },
  });
});

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe('generatePkce', () => {
  test('verifier and challenge are base64url and challenge is 43 chars (SHA-256 of 32 bytes)', async () => {
    const { verifier, challenge, state } = await generatePkce();
    expect(verifier).toMatch(BASE64URL);
    expect(verifier).toHaveLength(43);
    expect(challenge).toMatch(BASE64URL);
    expect(challenge).toHaveLength(43);
    expect(state).toMatch(/^[a-f0-9]{32}$/);
  });

  test('two calls produce different verifiers and states', async () => {
    const a = await generatePkce();
    const b = await generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
  });
});

describe('parseCallbackPaste', () => {
  test('parses a full https URL', () => {
    const parsed = parseCallbackPaste('https://platform.claude.com/oauth/code/callback?code=abc&state=xyz');
    expect(parsed).toEqual({ code: 'abc', state: 'xyz' });
  });

  test('parses an http localhost URL', () => {
    const parsed = parseCallbackPaste('http://localhost:1455/auth/callback?code=abc&state=xyz');
    expect(parsed).toEqual({ code: 'abc', state: 'xyz' });
  });

  test('parses a bare query starting with ?', () => {
    const parsed = parseCallbackPaste('?code=abc&state=xyz');
    expect(parsed).toEqual({ code: 'abc', state: 'xyz' });
  });

  test('parses a bare query with no leading ?', () => {
    const parsed = parseCallbackPaste('code=abc&state=xyz');
    expect(parsed).toEqual({ code: 'abc', state: 'xyz' });
  });

  test('parses a host-relative URL', () => {
    const parsed = parseCallbackPaste('platform.claude.com/oauth/code/callback?code=abc&state=xyz');
    expect(parsed).toEqual({ code: 'abc', state: 'xyz' });
  });

  test('parses Claude Code CLI code#state format', () => {
    const parsed = parseCallbackPaste('abc#xyz');
    expect(parsed).toEqual({ code: 'abc', state: 'xyz' });
  });

  test('rejects empty input', () => {
    expect(() => parseCallbackPaste('')).toThrow();
    expect(() => parseCallbackPaste('   ')).toThrow();
  });

  test('rejects code#state with empty code', () => {
    expect(() => parseCallbackPaste('#xyz')).toThrow('Invalid code');
  });

  test('rejects code#state with empty state', () => {
    expect(() => parseCallbackPaste('abc#')).toThrow('Invalid code');
  });

  test('rejects code#state with extra # separator', () => {
    expect(() => parseCallbackPaste('abc#xyz#extra')).toThrow('Invalid code');
  });

  test('rejects a URL missing code', () => {
    expect(() => parseCallbackPaste('https://example.com/cb?state=xyz')).toThrow(/code/);
  });

  test('rejects a URL missing state', () => {
    expect(() => parseCallbackPaste('https://example.com/cb?code=abc')).toThrow(/state/);
  });

  test('rejects a malformed https URL', () => {
    expect(() => parseCallbackPaste('https://malformed')).toThrow();
  });
});

describe('stashPkce / recallPkce / clearPkce', () => {
  beforeEach(() => { sessionStorage.clear(); });

  const key = pkceStorageKey('codex');

  test('returns {verifier} on matching state without consuming the entry', () => {
    stashPkce(key, { verifier: 'v1', state: 's1' });
    const recalled = recallPkce(key, 's1');
    expect(recalled).toEqual({ verifier: 'v1' });
    // Non-destructive: callers explicitly clearPkce on success so a failed
    // exchange leaves the stash for retry.
    expect(sessionStorage.getItem(key)).not.toBeNull();
    expect(recallPkce(key, 's1')).toEqual({ verifier: 'v1' });
  });

  test('clearPkce removes the entry', () => {
    stashPkce(key, { verifier: 'v1', state: 's1' });
    clearPkce(key);
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(recallPkce(key, 's1')).toBeNull();
  });

  test('returns null when state does not match and leaves the entry intact', () => {
    stashPkce(key, { verifier: 'v1', state: 's1' });
    const recalled = recallPkce(key, 'wrong');
    expect(recalled).toBeNull();
    expect(sessionStorage.getItem(key)).not.toBeNull();
  });

  test('returns null when nothing was stashed', () => {
    expect(recallPkce(key, 'anything')).toBeNull();
  });

  test('codex and claude-code use distinct storage keys', () => {
    expect(pkceStorageKey('codex')).not.toBe(pkceStorageKey('claude-code'));
  });

  test('claude-code oauth and setup-token use distinct storage keys', () => {
    expect(pkceStorageKey('claude-code', 'oauth')).not.toBe(pkceStorageKey('claude-code', 'setup-token'));
  });

  test('preparing one kind does not overwrite the other for claude-code', () => {
    const oauthKey = pkceStorageKey('claude-code', 'oauth');
    const setupTokenKey = pkceStorageKey('claude-code', 'setup-token');
    stashPkce(oauthKey, { verifier: 'v_oauth', state: 's_oauth' });
    stashPkce(setupTokenKey, { verifier: 'v_setup', state: 's_setup' });
    expect(recallPkce(oauthKey, 's_oauth')).toEqual({ verifier: 'v_oauth' });
    expect(recallPkce(setupTokenKey, 's_setup')).toEqual({ verifier: 'v_setup' });
  });
});

describe('peekStashedPkce', () => {
  beforeEach(() => { sessionStorage.clear(); });
  const key = pkceStorageKey('codex');

  test('returns the stash without removing it', () => {
    stashPkce(key, { verifier: 'v1', state: 's1' });
    expect(peekStashedPkce(key)).toEqual({ verifier: 'v1', state: 's1' });
    expect(peekStashedPkce(key)).toEqual({ verifier: 'v1', state: 's1' });
    expect(recallPkce(key, 's1')).toEqual({ verifier: 'v1' });
  });

  test('returns null when nothing is stashed', () => {
    expect(peekStashedPkce(key)).toBeNull();
  });
});

describe('deriveChallenge', () => {
  test('matches what generatePkce produces for the same verifier', async () => {
    const generated = await generatePkce();
    const derived = await deriveChallenge(generated.verifier);
    expect(derived).toBe(generated.challenge);
  });
});
