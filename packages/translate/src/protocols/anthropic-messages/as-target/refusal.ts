import type { AnthropicMessagesRefusalStopDetails } from '@floway-dev/protocols/anthropic-messages';

export const anthropicMessagesRefusalExplanation = (details: AnthropicMessagesRefusalStopDetails | null | undefined): string => {
  if (details?.explanation !== null && details?.explanation !== undefined) return details.explanation;

  const category = details?.category === null || details?.category === undefined
    ? 'an unspecified policy category'
    : `the ${details.category} policy category`;
  return `Anthropic refused this request under ${category}.`;
};
