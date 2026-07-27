import type { Repo } from '../repo/types.ts';
import { parseProxyUri, type ProxyConfig, type ProxyUriError } from '@floway-dev/proxy';

// Pairs the parsed wire config with an optional per-proxy dial deadline so a
// slow but real proxy can be granted more time without raising the bar for the
// whole gateway.
export interface ProxyEntry {
  config: ProxyConfig;
  /** ms; null means "use the dialer's default". */
  dialTimeoutMs: number | null;
}

export interface ProxyCatalog {
  readonly proxyById: Map<string, ProxyEntry>;
  readonly parseErrors: Map<string, ProxyUriError>;
}

export const loadProxyCatalog = async (
  repo: Pick<Repo, 'proxies'>,
  referencedIds: ReadonlySet<string>,
): Promise<ProxyCatalog> => {
  const proxyById = new Map<string, ProxyEntry>();
  const parseErrors = new Map<string, ProxyUriError>();
  if (referencedIds.size === 0) return { proxyById, parseErrors };

  const proxies = await repo.proxies.list();
  for (const proxy of proxies) {
    if (!referencedIds.has(proxy.id)) continue;
    try {
      proxyById.set(proxy.id, {
        config: parseProxyUri(proxy.url),
        dialTimeoutMs: proxy.dialTimeoutSeconds === null ? null : proxy.dialTimeoutSeconds * 1000,
      });
    } catch (error) {
      parseErrors.set(proxy.id, error as ProxyUriError);
    }
  }
  return { proxyById, parseErrors };
};
