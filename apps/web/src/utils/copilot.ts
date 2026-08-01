import type { CopilotUpstreamState } from '../api/types.ts';

// Map the per-tier baseUrl GitHub returns from /copilot_internal/v2/token's
// `endpoints.api` to the marketing label the dashboard renders. Returns
// null when state has never been seeded (freshly imported and not yet
// usable) or when GitHub routes us to a host we don't have a label for
// yet — callers fall back to `COPILOT_GENERIC_LABEL` for display.
export type CopilotAccountTypeLabel = 'individual' | 'business' | 'enterprise';

export const COPILOT_GENERIC_LABEL = 'copilot';

const BASE_URL_TO_LABEL: Record<string, CopilotAccountTypeLabel> = {
  'https://api.individual.githubcopilot.com': 'individual',
  'https://api.business.githubcopilot.com': 'business',
  'https://api.enterprise.githubcopilot.com': 'enterprise',
};

// Takes the token slot rather than the whole state: the label is a pure
// function of the per-tier host, and the rest of the state (quota snapshot,
// …) is none of this helper's business.
export const copilotAccountTypeLabel = (state: Pick<CopilotUpstreamState, 'copilotToken'> | null | undefined): CopilotAccountTypeLabel | null => {
  const baseUrl = state?.copilotToken?.baseUrl;
  return baseUrl ? BASE_URL_TO_LABEL[baseUrl] ?? null : null;
};

// Display label with the generic-fallback applied for callers that render
// a non-empty string unconditionally (badge text, settings-row subtitle).
export const copilotAccountTypeDisplay = (state: Pick<CopilotUpstreamState, 'copilotToken'> | null | undefined): string =>
  copilotAccountTypeLabel(state) ?? COPILOT_GENERIC_LABEL;
