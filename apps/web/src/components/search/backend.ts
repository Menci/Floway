import type { SearchConfig } from '../../api/types';

// The settings picker and the usage panel name the same backends, so the
// labels live once, keyed by the wire id both surfaces carry.
export const SEARCH_BACKEND_LABEL_KEYS: Record<string, string> = {
  'disabled': 'search.backend.disabled',
  'tavily': 'search.backend.tavily',
  'microsoft-web-iq': 'search.backend.microsoftWebIq',
  'jina': 'search.backend.jina',
} satisfies Record<SearchConfig['backend'], string>;
