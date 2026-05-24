// TODO: Delete and fully rewrite the frontend build when migrating to a bundler.
// This type-only cross-package import is a temporary exception kept while the
// dashboard is server-rendered Hono JSX. The SPA rewrite removes both this
// import and the apps/api exports map exception that enables it.
// eslint-disable-next-line no-restricted-imports
import type { SearchConfig } from '@floway-dev/api/data-plane/tools/web-search/types';

export interface DashboardSearchConfigDraft {
  provider: SearchConfig['provider'];
  tavilyApiKey: string;
  microsoftGroundingApiKey: string;
}

export const draftFromSearchConfig = (config: SearchConfig): DashboardSearchConfigDraft => ({
  provider: config.provider,
  tavilyApiKey: config.tavily.apiKey,
  microsoftGroundingApiKey: config.microsoftGrounding.apiKey,
});

export const activeCredentialValue = (draft: DashboardSearchConfigDraft): string =>
  draft.provider === 'tavily' ? draft.tavilyApiKey : draft.provider === 'microsoft-grounding' ? draft.microsoftGroundingApiKey : '';

export const setActiveCredentialValue = (draft: DashboardSearchConfigDraft, value: string): DashboardSearchConfigDraft =>
  draft.provider === 'tavily' ? { ...draft, tavilyApiKey: value } : draft.provider === 'microsoft-grounding' ? { ...draft, microsoftGroundingApiKey: value } : draft;

export const searchConfigFromDraft = (draft: DashboardSearchConfigDraft): SearchConfig => ({
  provider: draft.provider,
  tavily: { apiKey: draft.tavilyApiKey },
  microsoftGrounding: { apiKey: draft.microsoftGroundingApiKey },
});
