// Resolve a codex models catalog for a given codex client version.
//
// Strategy:
//   1. Parse `codex_exec/<version>` from the request user-agent
//   2. In-memory cache by version (catalog of a released codex tag is immutable)
//   3. On cache miss, fetch the matching tag from
//      `https://raw.githubusercontent.com/openai/codex/rust-v<version>/codex-rs/models-manager/models.json`
//   4. Fall back to the bundled snapshot on any failure: missing/unparseable
//      user-agent, GitHub 404 (unreleased version), network error
//
// The bundled snapshot is a frozen copy of
//   https://github.com/openai/codex/blob/rust-v0.136.0/codex-rs/models-manager/models.json
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
  [key: string]: unknown;
}

export interface CodexCatalog {
  models: CatalogModel[];
}

const VERSION_FROM_USER_AGENT = /codex_exec\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/;

const inMemoryCache = new Map<string, CodexCatalog>();

const bundled = bundledCatalog as unknown as CodexCatalog;

const parseCodexVersion = (userAgent: string | undefined): string | null =>
  userAgent?.match(VERSION_FROM_USER_AGENT)?.[1] ?? null;

const fetchCodexCatalog = async (version: string): Promise<CodexCatalog | null> => {
  const url = `https://raw.githubusercontent.com/openai/codex/rust-v${version}/codex-rs/models-manager/models.json`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  return (await resp.json()) as CodexCatalog;
};

export const resolveCodexCatalog = async (userAgent: string | undefined): Promise<CodexCatalog> => {
  const version = parseCodexVersion(userAgent);
  if (version === null) return bundled;

  const cached = inMemoryCache.get(version);
  if (cached !== undefined) return cached;

  const fetched = await fetchCodexCatalog(version).catch(() => null);
  const resolved = fetched ?? bundled;
  inMemoryCache.set(version, resolved);
  return resolved;
};
