// Resolve a codex models catalog for a given codex client version.
//
// Strategy:
//   1. Parse `<codex-originator>/<version>` from the request user-agent
//   2. In-memory cache by version (catalog of a released codex tag is immutable)
//   3. On cache miss, fetch the matching tag from
//      `https://raw.githubusercontent.com/openai/codex/rust-v<version>/codex-rs/models-manager/models.json`
//   4. Fall back to the bundled snapshot on any failure: missing/unparseable
//      user-agent, GitHub 404 (unreleased version), network error
//
// The bundled snapshot is a frozen copy of
//   https://github.com/openai/codex/blob/rust-v0.144.1/codex-rs/models-manager/models.json
// (Apache-2.0). It is the working fallback for cold starts, clients running
// unreleased prerelease builds, and operators behind network egress
// restrictions. Refresh it whenever a newer codex release ships material
// changes to the catalog:
//   curl -sf https://raw.githubusercontent.com/openai/codex/rust-v<NEW>/codex-rs/models-manager/models.json \
//     > packages/gateway/src/data-plane/codex/catalog/bundled.json
// then bump the tag reference in this comment to match.

import bundledCatalog from './catalog/bundled.json' with { type: 'json' };

export interface CatalogModel {
  slug: string;
  multi_agent_version?: string | null;
  supported_reasoning_levels?: CodexReasoningLevel[];
  [key: string]: unknown;
}

export interface CodexReasoningLevel {
  effort: string;
  description: string;
}

export interface CodexCatalog {
  models: CatalogModel[];
}

export interface CodexCatalogCapabilities {
  ultraReasoningLevel?: CodexReasoningLevel;
}

export interface CodexCatalogResolution {
  catalog: CodexCatalog;
  capabilities: CodexCatalogCapabilities;
}

// Codex uses its active originator as the User-Agent product token, followed
// by the app-server build version. This covers CLI, Desktop, IDE, and legacy
// `codex_exec` originators without coupling catalog resolution to one surface.
// https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/login/src/auth/default_client.rs#L161-L172
const VERSION_FROM_USER_AGENT = /^codex[^/]*\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/i;

const inMemoryCache = new Map<string, CodexCatalogResolution>();

const bundled = bundledCatalog as unknown as CodexCatalog;

// Floway may extend Ultra to other Max-capable models only after the exact
// client-version catalog proves that this Codex build supports the v2 Ultra
// semantics. A bundled fallback cannot prove anything about the caller.
// https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/models-manager/models.json#L19-L58
// https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/core/src/session/multi_agents.rs#L39-L54
// https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/codex-rs/core/src/client.rs#L175-L180
const capabilitiesFromExactCatalog = (catalog: CodexCatalog): CodexCatalogCapabilities => {
  for (const model of catalog.models) {
    if (model.multi_agent_version !== 'v2') continue;
    const ultraReasoningLevel = model.supported_reasoning_levels?.find(level => level.effort === 'ultra');
    if (ultraReasoningLevel !== undefined) return { ultraReasoningLevel };
  }
  return {};
};

const bundledFallback = (): CodexCatalogResolution => ({ catalog: bundled, capabilities: {} });

const parseCodexVersion = (userAgent: string | undefined): string | null =>
  userAgent?.match(VERSION_FROM_USER_AGENT)?.[1] ?? null;

const fetchCodexCatalog = async (version: string): Promise<CodexCatalog | null> => {
  const url = `https://raw.githubusercontent.com/openai/codex/rust-v${version}/codex-rs/models-manager/models.json`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  return (await resp.json()) as CodexCatalog;
};

export const resolveCodexCatalog = async (userAgent: string | undefined): Promise<CodexCatalogResolution> => {
  const version = parseCodexVersion(userAgent);
  if (version === null) return bundledFallback();

  const cached = inMemoryCache.get(version);
  if (cached !== undefined) return cached;

  const fetched = await fetchCodexCatalog(version).catch(() => null);
  const resolved = fetched === null
    ? bundledFallback()
    : { catalog: fetched, capabilities: capabilitiesFromExactCatalog(fetched) };
  inMemoryCache.set(version, resolved);
  return resolved;
};
