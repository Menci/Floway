import { describe, expect, it } from 'vitest';

import { codexUnixCredentialSnippet, codexWindowsCredentialSnippet } from '../../../src/components/api-keys/agent-setup';

describe('Codex provider credentials', () => {
  it('stores a provider-scoped token without replacing auth.json', () => {
    const unix = codexUnixCredentialSnippet("floway-'key");
    expect(unix).toContain('floway-token');
    expect(unix).toContain("'floway-'\"'\"'key'");
    expect(unix).not.toContain('auth.json');

    const windows = codexWindowsCredentialSnippet("floway-'key");
    expect(windows).toContain('floway-token');
    expect(windows).toContain("'floway-''key'");
    expect(windows).not.toContain('auth.json');
  });
});
