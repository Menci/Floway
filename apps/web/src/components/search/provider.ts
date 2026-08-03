import type { SearchConfig } from '../../api/types';

// The settings picker and the usage panel name the same providers, so the
// labels live once, keyed by the wire id both surfaces carry.
export const SEARCH_PROVIDER_LABEL_KEYS: Record<string, string> = {
  'disabled': 'dashboard.searchConfig.provider.disabled',
  'tavily': 'dashboard.searchConfig.provider.tavily',
  'microsoft-web-iq': 'dashboard.searchConfig.provider.microsoftWebIq',
  'jina': 'dashboard.searchConfig.provider.jina',
} satisfies Record<SearchConfig['provider'], string>;
