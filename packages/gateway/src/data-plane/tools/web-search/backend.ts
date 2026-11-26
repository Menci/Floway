import { createJinaWebSearchBackend } from './backends/jina.ts';
import { createMicrosoftWebIqWebSearchBackend } from './backends/microsoft-web-iq.ts';
import { createTavilyWebSearchBackend } from './backends/tavily.ts';
import { FIXED_WEB_SEARCH_CONFIG_TEST_QUERY } from './config.ts';
import type { ConfiguredWebSearchBackend, WebSearchConfig, WebSearchConfigConnectionTestResult, WebSearchBackend, WebSearchBackendName } from './types.ts';

const toPreviewText = (content: Array<{ type: 'text'; text: string }>): string =>
  content
    .map(block => block.text)
    .join('\n')
    .slice(0, 280);

// Per-backend lookup: pulls the credential out of the config slot for
// that backend and constructs the impl. Keeps `resolveConfiguredWeb...`
// data-driven so adding a fourth backend is one entry, not another
// if-branch.
const BACKEND_FACTORIES: { [N in WebSearchBackendName]: (config: WebSearchConfig) => { apiKey: string; build: (apiKey: string) => WebSearchBackend } } = {
  tavily: config => ({ apiKey: config.tavily.apiKey, build: createTavilyWebSearchBackend }),
  'microsoft-web-iq': config => ({ apiKey: config.microsoftWebIq.apiKey, build: createMicrosoftWebIqWebSearchBackend }),
  jina: config => ({ apiKey: config.jina.apiKey, build: createJinaWebSearchBackend }),
};

export const resolveConfiguredWebSearchBackend = (config: WebSearchConfig): ConfiguredWebSearchBackend => {
  if (config.backend === 'disabled') {
    return { type: 'disabled' };
  }

  const factory = BACKEND_FACTORIES[config.backend](config);
  if (!factory.apiKey) {
    return { type: 'missing-credential', backend: config.backend };
  }

  return {
    type: 'enabled',
    backend: config.backend,
    impl: factory.build(factory.apiKey),
  };
};

export const testWebSearchConfigConnection = async (config: WebSearchConfig): Promise<WebSearchConfigConnectionTestResult> => {
  const resolved = resolveConfiguredWebSearchBackend(config);

  if (resolved.type === 'disabled') {
    return {
      ok: false,
      backend: 'disabled',
      query: FIXED_WEB_SEARCH_CONFIG_TEST_QUERY,
      error: {
        code: 'disabled',
        message: 'Search backend is disabled.',
      },
    };
  }

  if (resolved.type === 'missing-credential') {
    return {
      ok: false,
      backend: resolved.backend,
      query: FIXED_WEB_SEARCH_CONFIG_TEST_QUERY,
      error: {
        code: 'missing_credential',
        message: `Missing API key for ${resolved.backend}.`,
      },
    };
  }

  const result = await resolved.impl.search({ query: FIXED_WEB_SEARCH_CONFIG_TEST_QUERY });

  if (result.type === 'error') {
    return {
      ok: false,
      backend: resolved.backend,
      query: FIXED_WEB_SEARCH_CONFIG_TEST_QUERY,
      error: {
        code: result.errorCode,
        message: result.message ?? 'Search test failed.',
      },
    };
  }

  const previews = result.results.slice(0, 3).map(entry => ({
    title: entry.title,
    url: entry.source,
    ...(entry.pageAge === undefined ? {} : { pageAge: entry.pageAge }),
    previewText: toPreviewText(entry.content),
  }));

  if (previews.length === 0) {
    return {
      ok: false,
      backend: resolved.backend,
      query: FIXED_WEB_SEARCH_CONFIG_TEST_QUERY,
      error: {
        code: 'no_results',
        message: 'Search returned no preview results.',
      },
    };
  }

  return {
    ok: true,
    backend: resolved.backend,
    query: FIXED_WEB_SEARCH_CONFIG_TEST_QUERY,
    results: previews,
  };
};
