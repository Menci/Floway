import { resolveConfiguredWebSearchBackend } from '../../tools/web-search/backend.ts';
import { loadWebSearchConfig } from '../../tools/web-search/config.ts';
import type { WebSearchExecutionSession } from '../../tools/web-search/operations.ts';
import type { ConfiguredWebSearchBackend, WebSearchConfig } from '../../tools/web-search/types.ts';

type PageCache = WebSearchExecutionSession['pageCache'];
type Page = PageCache extends Map<string, infer Value> ? Value : never;

const MAX_CACHED_PAGES = 64;

class BoundedPageCache extends Map<string, Page> {
  override set(url: string, page: Page): this {
    this.delete(url);
    if (this.size === MAX_CACHED_PAGES) {
      const oldest = this.keys().next();
      if (!oldest.done) this.delete(oldest.value);
    }
    return super.set(url, page);
  }
}

export interface LocalWebSearchService {
  readonly apiKeyId: string;
  readonly pageCache: PageCache;
  getBackend(): Promise<ConfiguredWebSearchBackend>;
  passthroughConfiguration(): Promise<Readonly<WebSearchConfig['passthroughOpenAiSearch']>>;
}

export const createLocalWebSearchService = (apiKeyId: string): LocalWebSearchService => {
  let configuration: Promise<WebSearchConfig> | undefined;
  let backend: Promise<ConfiguredWebSearchBackend> | undefined;
  const config = () => configuration ??= loadWebSearchConfig();
  return {
    apiKeyId,
    pageCache: new BoundedPageCache(),
    getBackend: () => backend ??= config().then(resolveConfiguredWebSearchBackend),
    passthroughConfiguration: async () => (await config()).passthroughOpenAiSearch,
  };
};
