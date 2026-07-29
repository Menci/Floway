// Shared normalizer for `allowed_domains` / `blocked_domains` list
// entries, used by the local URL-allowed filter, the Tavily
// include/exclude payload, and the Microsoft Web IQ `site:` builder.
// All three must agree on what a "domain entry" means — we unify on
// the strictest of the three: trim, lowercase, validate. Entries that
// fail validation drop, matching Microsoft Web IQ's behavior.
//
// Pattern requires at least one dot; labels are 1-63 chars of
// `[a-z0-9-]`, may not start or end with `-`. Schemes, ports, paths,
// or whitespace inside an entry reject. Conservative on purpose; not
// RFC 1035.

const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/;

export const normalizeDomainEntry = (raw: string): string | null => {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '') return null;
  if (!DOMAIN_PATTERN.test(trimmed)) return null;
  return trimmed;
};

export const normalizeDomainList = (raw: readonly string[] | undefined): string[] => {
  if (raw === undefined) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const normalized = normalizeDomainEntry(entry);
    if (normalized !== null) out.push(normalized);
  }
  return out;
};
