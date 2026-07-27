import { describe, expect, it } from "vitest";

import { buildClaudeSettingsSnippet, codexUnixCredentialSnippet, codexWindowsCredentialSnippet } from "../../../src/components/api-keys/cli-configuration";

describe("Claude Code settings snippet", () => {
  it("writes every model tier into the settings env block", () => {
    expect(JSON.parse(buildClaudeSettingsSnippet("https://floway.example", "secret", {
      fable: "claude-fable[1m]",
      opus: "claude-opus[1m]",
      sonnet: "claude-sonnet[1m]",
      haiku: "claude-haiku",
    }))).toEqual({
      env: {
        ANTHROPIC_BASE_URL: "https://floway.example",
        ANTHROPIC_AUTH_TOKEN: "secret",
        ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable[1m]",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus[1m]",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet[1m]",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku",
      },
    });
  });
});

describe("Codex provider credentials", () => {
  it("stores a provider-scoped token without replacing auth.json", () => {
    const unix = codexUnixCredentialSnippet("floway-'key");
    expect(unix).toContain('floway-token');
    expect(unix).toContain("'floway-'\"'\"'key'");
    expect(unix).not.toContain("auth.json");

    const windows = codexWindowsCredentialSnippet("floway-'key");
    expect(windows).toContain('floway-token');
    expect(windows).toContain("'floway-''key'");
    expect(windows).not.toContain("auth.json");
  });
});
